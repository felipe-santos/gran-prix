import { useCallback, useRef } from 'react';
import * as planck from 'planck-js';
import * as wasm from '../wasm/pkg/gran_prix_wasm';
import {
    WALKER_POPULATION_SIZE,
    WALKER_INPUTS,
    WALKER_OUTPUTS,
    WALKER_MAX_FRAMES,
    WalkerGameState,
    WalkerStats,
} from '../types';
import {
    WalkerBody,
    createWalkerWorld,
    createWalkerBody,
    getWalkerInputs,
    applyWalkerOutputs,
    isWalkerDead,
    computeWalkerFitness,
} from '../lib/walkerPhysics';

// ── Physics timestep ────────────────────────────────────────────────────────

const PHYSICS_DT = 1 / 60;
const VELOCITY_ITERATIONS = 6;
const POSITION_ITERATIONS = 2;

interface UseWalkerGameLoopProps {
    computeWalker: (inputs: Float32Array) => Float32Array | null;
    evolve: (
        fitnessScores: number[],
        mutationRate: number,
        mutationScale: number,
        strategy: wasm.MutationStrategy,
    ) => void;
    setStats: React.Dispatch<React.SetStateAction<WalkerStats>>;
    mutationRate: number;
    mutationScale: number;
    mutationStrategy: wasm.MutationStrategy;
    onGenerationEnd: (maxFitness: number, avgFitness: number) => void;
}

/**
 * Pure physics + AI hook for the Bipedal Walker neuro-evolution demo.
 *
 * Design decisions:
 * - All mutable simulation state lives in refs to avoid React re-renders per frame.
 * - The planck.js world is created once and walkers are respawned each generation.
 * - Each frame: step physics → extract sensors → WASM forward pass → apply motors → check death.
 * - Generation ends when all walkers are dead OR WALKER_MAX_FRAMES reached.
 */
export function useWalkerGameLoop({
    computeWalker,
    evolve,
    setStats,
    mutationRate,
    mutationScale,
    mutationStrategy,
    onGenerationEnd,
}: UseWalkerGameLoopProps) {
    const gameState = useRef<WalkerGameState>({
        agents: [],
        frame: 0,
        generation: 1,
    });

    // Stable refs so updatePhysics never becomes stale
    const mutationRateRef = useRef(mutationRate);
    const mutationScaleRef = useRef(mutationScale);
    const mutationStrategyRef = useRef(mutationStrategy);
    mutationRateRef.current = mutationRate;
    mutationScaleRef.current = mutationScale;
    mutationStrategyRef.current = mutationStrategy;

    const isComputing = useRef(false);

    // Per-agent physics data (not in React state — refs only)
    const worldRef = useRef<planck.World | null>(null);
    const walkersRef = useRef<WalkerBody[]>([]);
    const framesAliveRef = useRef<number[]>([]);

    /**
     * Initialize or reset the physics world and spawn all walkers.
     */
    const resetWalker = useCallback(() => {
        // Destroy old world if exists
        if (worldRef.current) {
            // planck.js doesn't have a world.clear(), we just discard the reference
            worldRef.current = null;
            walkersRef.current = [];
        }

        const world = createWalkerWorld();
        worldRef.current = world;

        const walkers: WalkerBody[] = [];
        for (let i = 0; i < WALKER_POPULATION_SIZE; i++) {
            // Spawn walkers spread out slightly so they don't all overlap visually
            const spawnX = 2 + i * 0.05;
            walkers.push(createWalkerBody(world, spawnX, i));
        }
        walkersRef.current = walkers;
        framesAliveRef.current = new Array(WALKER_POPULATION_SIZE).fill(0);

        const state = gameState.current;
        state.agents = Array.from({ length: WALKER_POPULATION_SIZE }, (_, i) => ({
            id: i,
            distance: 0,
            dead: false,
            fitness: 0,
            color: `hsl(${(i / WALKER_POPULATION_SIZE) * 360}, 75%, 60%)`,
        }));
        state.frame = 0;

        setStats(s => ({ ...s, alive: WALKER_POPULATION_SIZE, avgDistance: 0 }));
    }, [setStats]);

    /**
     * Called when all walkers are dead or time limit hit — run evolution and restart.
     */
    const runEvolution = useCallback(() => {
        const state = gameState.current;
        const walkers = walkersRef.current;
        const framesAlive = framesAliveRef.current;

        // Compute final fitness for all agents
        const scores = walkers.map((w, i) => computeWalkerFitness(w, framesAlive[i]));
        const maxFitness = Math.max(...scores);
        const avgFitness = scores.reduce((a, b) => a + b, 0) / scores.length;

        try {
            evolve(
                scores,
                mutationRateRef.current,
                mutationScaleRef.current,
                mutationStrategyRef.current,
            );
            state.generation++;
            setStats(s => ({
                ...s,
                generation: state.generation,
                best: Math.max(s.best, maxFitness),
            }));
            onGenerationEnd(maxFitness, avgFitness);
            resetWalker();
        } catch (e) {
            console.error('WALKER: evolution error:', e);
        }
    }, [evolve, resetWalker, setStats, onGenerationEnd]);

    /**
     * Core physics + AI tick. Called once per animation frame.
     *
     * Order: step physics → extract sensors → WASM forward pass → apply motors → check death
     */
    const updateWalkerPhysics = useCallback(() => {
        const state = gameState.current;
        const world = worldRef.current;
        const walkers = walkersRef.current;
        const framesAlive = framesAliveRef.current;

        if (!world || walkers.length === 0) return;

        const aliveIndices = state.agents
            .map((a, i) => (!a.dead ? i : -1))
            .filter(i => i >= 0);

        // Check for end-of-generation conditions
        if (aliveIndices.length === 0 || state.frame >= WALKER_MAX_FRAMES) {
            runEvolution();
            return;
        }

        state.frame++;

        // ── Step the physics world ────────────────────────────────────────────
        world.step(PHYSICS_DT, VELOCITY_ITERATIONS, POSITION_ITERATIONS);

        // ── Build WASM inputs for all alive walkers ───────────────────────────
        const inputs = new Float32Array(WALKER_POPULATION_SIZE * WALKER_INPUTS);

        for (const idx of aliveIndices) {
            const sensorValues = getWalkerInputs(walkers[idx]);
            for (let j = 0; j < WALKER_INPUTS; j++) {
                inputs[idx * WALKER_INPUTS + j] = sensorValues[j];
            }
        }

        // ── WASM forward pass ─────────────────────────────────────────────────
        if (!isComputing.current) {
            isComputing.current = true;
            try {
                const outputs = computeWalker(inputs);
                if (outputs) {
                    for (const idx of aliveIndices) {
                        const agentOutputs: number[] = [];
                        for (let j = 0; j < WALKER_OUTPUTS; j++) {
                            agentOutputs.push(outputs[idx * WALKER_OUTPUTS + j]);
                        }
                        applyWalkerOutputs(walkers[idx], agentOutputs);
                    }
                }
            } catch (e) {
                console.error('WALKER: WASM compute error:', e);
            } finally {
                isComputing.current = false;
            }
        }

        // ── Update alive counters and check death ─────────────────────────────
        let aliveCount = 0;
        let totalDistance = 0;

        for (const idx of aliveIndices) {
            framesAlive[idx]++;

            if (isWalkerDead(walkers[idx])) {
                state.agents[idx].dead = true;
                state.agents[idx].fitness = computeWalkerFitness(walkers[idx], framesAlive[idx]);
                // Stop walker body from simulating by putting it to sleep
                walkers[idx].torso.setActive(false);
                walkers[idx].upperLegL.setActive(false);
                walkers[idx].lowerLegL.setActive(false);
                walkers[idx].upperLegR.setActive(false);
                walkers[idx].lowerLegR.setActive(false);
            } else {
                aliveCount++;
                const dist = walkers[idx].torso.getPosition().x - walkers[idx].spawnX;
                state.agents[idx].distance = dist;
                totalDistance += dist;
            }
        }

        // Publish stats every 10 frames to avoid React thrashing
        if (state.frame % 10 === 0) {
            setStats(prev => ({
                ...prev,
                alive: aliveCount,
                avgDistance: aliveCount > 0
                    ? parseFloat((totalDistance / aliveCount).toFixed(2))
                    : prev.avgDistance,
            }));
        }
    }, [computeWalker, runEvolution, setStats]);

    return {
        gameState,
        worldRef,
        walkersRef,
        resetWalker,
        updateWalkerPhysics,
    };
}
