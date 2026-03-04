import { useEffect, useState, useCallback, useMemo } from 'react';
import { BipedPhysics } from './BipedPhysics';
import { useWasmPopulation } from '../../hooks/useWasmPopulation';
import { MutationStrategy } from '../../wasm/pkg/gran_prix_wasm';

export interface BipedAgent {
    id: number;
    physics: BipedPhysics;
    fitness: number;
    isAlive: boolean;
    color: string;
}

export const BIPED_SENSORS = 10;
export const BIPED_HIDDEN = [16]; // We will use GRU in Rust, but WASM topology defines sizes
export const BIPED_MOTORS = 4;
export const POPULATION_SIZE = 50;
export const MAX_FRAMES = 600; // 10 seconds per generation

const AGENT_COLORS = [
    '#FF3366', '#33CCFF', '#00FF66', '#FF9900', '#CC33FF',
    '#FFFF00', '#00FFFF', '#FF00FF', '#C0C0C0', '#FFFFFF'
];

export function useBipedEvolution() {
    const { population, initWasm, evolve, computeAll } = useWasmPopulation(
        POPULATION_SIZE,
        BIPED_SENSORS,
        BIPED_HIDDEN,
        BIPED_MOTORS
    );

    const [agents, setAgents] = useState<BipedAgent[]>([]);
    const [generation, setGeneration] = useState(1);
    const [frame, setFrame] = useState(0);
    const [maxFitness, setMaxFitness] = useState(0);
    const [isRunning, setIsRunning] = useState(true);

    // Initialize WASM
    useEffect(() => {
        initWasm();
    }, [initWasm]);

    const startNewGeneration = useCallback(() => {
        if (!population) return;

        // ** The Phase 5 Temporal Memory Reset **
        // Required to clear GRU memories between episodes
        if ('reset_memories' in population) {
            (population as any).reset_memories();
        }

        const newAgents: BipedAgent[] = [];
        for (let i = 0; i < POPULATION_SIZE; i++) {
            newAgents.push({
                id: i,
                physics: new BipedPhysics(),
                fitness: 0,
                isAlive: true,
                color: AGENT_COLORS[i % AGENT_COLORS.length]
            });
        }

        setAgents(newAgents);
        setFrame(0);
    }, [population]);

    // Start sequence when WASM loads
    useEffect(() => {
        if (population && agents.length === 0) {
            startNewGeneration();
        }
    }, [population, agents.length, startNewGeneration]);

    const advanceGeneration = useCallback(() => {
        if (!population || agents.length === 0) return;

        const fitnessScores = new Float32Array(POPULATION_SIZE);
        agents.forEach((agent, i) => {
            fitnessScores[i] = agent.fitness;
        });

        evolve(Array.from(fitnessScores), 0.2, 0.5, MutationStrategy.Additive);

        setGeneration(g => g + 1);
        startNewGeneration();
    }, [population, agents, evolve, startNewGeneration]);

    // Game Loop
    useEffect(() => {
        if (!isRunning || agents.length === 0 || !population) return;
        let animationId: number;

        const loop = () => {
            setFrame(f => {
                if (f >= MAX_FRAMES) {
                    advanceGeneration();
                    return 0;
                }

                setAgents(currentAgents => {
                    let anyAlive = false;
                    let currentMaxFit = 0;

                    // Collect sensors from all alive agents, pad with zeros for dead ones
                    const allSensors = new Float32Array(POPULATION_SIZE * BIPED_SENSORS);

                    currentAgents.forEach((agent, i) => {
                        if (!agent.isAlive) return;
                        const state = agent.physics.getState();
                        const offset = i * BIPED_SENSORS;

                        allSensors[offset] = state.torsoAngle;
                        allSensors[offset + 1] = state.leftHipAngle;
                        allSensors[offset + 2] = state.leftKneeAngle;
                        allSensors[offset + 3] = state.rightHipAngle;
                        allSensors[offset + 4] = state.rightKneeAngle;
                        allSensors[offset + 5] = state.headY;
                        allSensors[offset + 6] = state.headX;
                        allSensors[offset + 7] = state.leftFootContact ? 1.0 : 0.0;
                        allSensors[offset + 8] = state.rightFootContact ? 1.0 : 0.0;
                        allSensors[offset + 9] = state.velocityX;
                    });

                    // Vectorized WASM compute for the whole population!
                    let allOutputs: Float32Array | null = null;
                    try {
                        allOutputs = computeAll(allSensors);
                    } catch (e) { /* ignore */ }

                    const nextAgents = currentAgents.map((agent, i) => {
                        if (!agent.isAlive) return agent;

                        const state = agent.physics.getState();

                        if (state.headY < 2.0) {
                            return { ...agent, isAlive: false };
                        }

                        anyAlive = true;

                        if (allOutputs) {
                            const offset = i * BIPED_MOTORS;
                            const outputs = Array.from(allOutputs.slice(offset, offset + BIPED_MOTORS));
                            agent.physics.step(outputs);
                        }

                        agent.fitness = state.headX; // distance travelled
                        if (agent.fitness > currentMaxFit) {
                            currentMaxFit = agent.fitness;
                        }

                        return agent;
                    });

                    setMaxFitness(prev => Math.max(prev, currentMaxFit));

                    if (!anyAlive) {
                        setTimeout(advanceGeneration, 0);
                    }

                    return nextAgents;
                });

                return f + 1;
            });

            animationId = requestAnimationFrame(loop);
        };

        animationId = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(animationId);
    }, [isRunning, agents.length, population, computeAll, advanceGeneration]);

    const fitnessScores = useMemo(() => {
        const scores = new Float32Array(POPULATION_SIZE);
        agents.forEach((a, i) => scores[i] = a.fitness);
        return scores;
    }, [agents]);

    return {
        agents,
        generation,
        frame,
        maxFitness,
        isRunning,
        setIsRunning,
        population,
        fitnessScores
    };
}
