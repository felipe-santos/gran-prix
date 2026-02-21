import { useCallback, useRef } from 'react';
import * as wasm from '../wasm/pkg/gran_prix_wasm';
import {
    OVEN_POPULATION_SIZE,
    OVEN_INPUTS,
    OVEN_OUTPUTS,
    OVEN_MAX_FRAMES,
    OVEN_AMBIENT_TEMP,
    OVEN_MAX_TEMP,
    OVEN_FOODS,
    OvenFoodType,
    OvenGameState,
    OvenStats,
} from '../types';

// ─── Hook Interface ──────────────────────────────────────────────────────────

interface UseOvenGameLoopProps {
    computeOven: (inputs: Float32Array) => Float32Array | null;
    evolve: (
        fitnessScores: number[],
        mutationRate: number,
        mutationScale: number,
        strategy: wasm.MutationStrategy,
    ) => void;
    setStats: React.Dispatch<React.SetStateAction<OvenStats>>;
    mutationRate: number;
    mutationScale: number;
    mutationStrategy: wasm.MutationStrategy;
    onGenerationEnd: (maxFitness: number, avgFitness: number) => void;
}

export function useOvenGameLoop({
    computeOven,
    evolve,
    setStats,
    mutationRate,
    mutationScale,
    mutationStrategy,
    onGenerationEnd,
}: UseOvenGameLoopProps) {
    const gameState = useRef<OvenGameState>({
        agents: [],
        frame: 0,
        generation: 1,
        currentFoodType: OvenFoodType.Cake, // Start with Cake
        restingFrames: 0,
    });

    const mutationRateRef = useRef(mutationRate);
    const mutationScaleRef = useRef(mutationScale);
    const mutationStrategyRef = useRef(mutationStrategy);
    mutationRateRef.current = mutationRate;
    mutationScaleRef.current = mutationScale;
    mutationStrategyRef.current = mutationStrategy;

    const isComputing = useRef(false);

    // Helper: Pick the next food type cyclically or randomly
    const getNextFoodType = (current: OvenFoodType): OvenFoodType => {
        const types = Object.values(OvenFoodType);
        const currentIndex = types.indexOf(current);
        const nextIndex = (currentIndex + 1) % types.length;
        return types[nextIndex];
    };

    const resetOven = useCallback(() => {
        const state = gameState.current;
        const foodProfile = OVEN_FOODS[state.currentFoodType];

        state.agents = Array.from({ length: OVEN_POPULATION_SIZE }, (_, i) => ({
            id: i,
            fitness: 0,
            airTemp: OVEN_AMBIENT_TEMP,
            surfaceTemp: OVEN_AMBIENT_TEMP,
            coreTemp: OVEN_AMBIENT_TEMP,
            moisture: 1.0,
            topHeater: 0,
            bottomHeater: 0,
            fan: 0,
            cooked: false,
            burnt: false,
            energyUsed: 0,
            food: foodProfile,
            color: `hsl(${(i / OVEN_POPULATION_SIZE) * 200 + 40}, 70%, 55%)`,
        }));

        state.frame = 0;
        setStats(s => ({ 
            ...s, 
            bestCoreTemp: OVEN_AMBIENT_TEMP,
            successRates: s.successRates || {
                [OvenFoodType.Cake]: 0,
                [OvenFoodType.Bread]: 0,
                [OvenFoodType.Turkey]: 0,
                [OvenFoodType.Pizza]: 0,
            }
        }));
    }, [setStats]);

    const runEvolution = useCallback(() => {
        const state = gameState.current;
        const scores = state.agents.map(a => a.fitness);
        if (scores.length === 0) return;

        const maxFitness = Math.max(...scores);
        const avgFitness = scores.reduce((a, b) => a + b, 0) / scores.length;
        const successes = state.agents.filter(a => a.cooked && !a.burnt).length;

        try {
            evolve(scores, mutationRateRef.current, mutationScaleRef.current, mutationStrategyRef.current);

            setStats(s => ({
                ...s,
                generation: state.generation,
                bestFitness: maxFitness,
                avgFitness,
                bestCoreTemp: Math.max(...state.agents.map(a => a.coreTemp)),
                successRates: {
                    ...s.successRates,
                    [state.currentFoodType]: (successes / OVEN_POPULATION_SIZE) * 100
                }
            }));
            onGenerationEnd(maxFitness, avgFitness);

            state.generation++;
            state.currentFoodType = getNextFoodType(state.currentFoodType);
            resetOven();
        } catch (e) {
            console.error('OVEN: evolution error:', e);
        }
    }, [evolve, setStats, onGenerationEnd, resetOven]);

    const updatePhysics = useCallback(() => {
        if (isComputing.current) return;
        isComputing.current = true;

        try {
            const state = gameState.current;
            const { agents } = state;

            // Pre-check if all agents failed/succeeded early
            const activeAgents = agents.filter(a => !a.burnt && !a.cooked);
            if (activeAgents.length === 0) {
                state.restingFrames++;
            }
            if ((activeAgents.length === 0 && state.restingFrames > 300) || state.frame >= OVEN_MAX_FRAMES) {
                runEvolution();
                return;
            }

            // ── Prepare neural inputs ──
            const inputs = new Float32Array(OVEN_POPULATION_SIZE * OVEN_INPUTS);

            for (let i = 0; i < OVEN_POPULATION_SIZE; i++) {
                const agent = agents[i];
                if (agent.burnt || agent.cooked) continue; // Skip inputs if already done, outputs will be ignored
                const f = agent.food;
                const base = i * OVEN_INPUTS;

                inputs[base + 0] = agent.airTemp / OVEN_MAX_TEMP;
                inputs[base + 1] = agent.surfaceTemp / OVEN_MAX_TEMP;
                inputs[base + 2] = agent.coreTemp / OVEN_MAX_TEMP;
                // Target distances (absolute diff normalized)
                inputs[base + 3] = Math.max(0, (f.targetCore - agent.coreTemp) / 100.0);
                inputs[base + 4] = Math.max(0, (f.burnTemp - agent.surfaceTemp) / 100.0);
                // Progress
                inputs[base + 5] = state.frame / OVEN_MAX_FRAMES;
                // Food One-Hot
                inputs[base + 6] = f.type === OvenFoodType.Cake ? 1 : 0;
                inputs[base + 7] = f.type === OvenFoodType.Bread ? 1 : 0;
                inputs[base + 8] = f.type === OvenFoodType.Turkey ? 1 : 0;
                inputs[base + 9] = f.type === OvenFoodType.Pizza ? 1 : 0;
                // Moisture
                inputs[base + 10] = agent.moisture;
            }

            // ── Forward pass ──
            const outputs = computeOven(inputs);
            if (!outputs) return;

            // ── Apply Thermodynamics ──
            let currentBestCore = OVEN_AMBIENT_TEMP;

            for (let i = 0; i < OVEN_POPULATION_SIZE; i++) {
                const agent = agents[i];
                const isDone = agent.burnt || agent.cooked;

                if (isDone) {
                    agent.topHeater = 0;
                    agent.bottomHeater = 0;
                    agent.fan = 0;
                } else {
                    const outBase = i * OVEN_OUTPUTS;
                    agent.topHeater = Math.max(0, Math.min(1, outputs[outBase + 0]));
                    agent.bottomHeater = Math.max(0, Math.min(1, outputs[outBase + 1]));
                    agent.fan = outputs[outBase + 2] > 0.5 ? 1.0 : 0.0; // Binary fan

                    // Energy tracking
                    agent.energyUsed += agent.topHeater + agent.bottomHeater + (agent.fan * 0.3);
                }

                const f = agent.food;

                // 1. Heaters warm the air
                const heaterPower = (agent.topHeater * 2.0) + (agent.bottomHeater * 1.5);
                const heatingDelta = heaterPower * 0.8;
                const coolingDelta = (agent.airTemp - OVEN_AMBIENT_TEMP) * 0.005; // Oven leaks heat
                agent.airTemp += heatingDelta - coolingDelta;
                agent.airTemp = Math.max(OVEN_MAX_TEMP, agent.airTemp);

                // 2. Air warms the surface
                const fanMultiplier = agent.fan === 1.0 ? 1.5 : 1.0;
                const surfaceDelta = (agent.airTemp - agent.surfaceTemp) * f.surfaceConductivity * fanMultiplier * 0.01;
                // Direct radiation from top heater
                const radiationDelta = agent.topHeater * 0.2;
                agent.surfaceTemp += surfaceDelta + radiationDelta;

                // 3. Surface warms the core
                const coreDelta = (agent.surfaceTemp - agent.coreTemp) * f.coreConductivity * 0.01;
                agent.coreTemp += coreDelta;

                // 4. Moisture loss
                if (agent.surfaceTemp > 100) {
                    agent.moisture -= (agent.surfaceTemp - 100) * f.moistureLossRate * 0.0001;
                    agent.moisture = Math.max(0, agent.moisture);
                }

                if (!isDone) {
                    // Flags check
                    if (agent.surfaceTemp >= f.burnTemp) {
                        agent.burnt = true;
                    } else if (agent.coreTemp >= f.targetCore) {
                        agent.cooked = true;
                    }

                    // ── Compute Temporary/Final Fitness ──
                    // Base points for heating up the core
                    let fit = (agent.coreTemp - OVEN_AMBIENT_TEMP);

                    // Severe penalty if burnt
                    if (agent.burnt) {
                        fit -= 200;
                    }

                    // Reward if cooked perfectly without burning
                    if (agent.cooked && !agent.burnt) {
                        fit += 500;
                        // Bonus for preserving moisture
                        fit += agent.moisture * 200;
                        // Penalty for wasted time/energy
                        const timePenalty = (state.frame / OVEN_MAX_FRAMES) * 50;
                        const energyPenalty = agent.energyUsed * 0.05;
                        fit -= (timePenalty + energyPenalty);
                    }

                    agent.fitness = Math.max(0, fit);
                }

                currentBestCore = Math.max(currentBestCore, agent.coreTemp);
            }

            state.frame++;
            if (state.frame % 30 === 0) {
                setStats(s => ({ ...s, bestCoreTemp: currentBestCore }));
            }

        } finally {
            isComputing.current = false;
        }
    }, [computeOven, runEvolution, setStats]);

    return { gameState, resetOven, updatePhysics };
}
