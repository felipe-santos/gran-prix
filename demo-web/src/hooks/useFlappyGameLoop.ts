import { useCallback, useRef } from 'react';
import * as wasm from '../wasm/pkg/gran_prix_wasm';
import {
    FLAPPY_WIDTH,
    FLAPPY_HEIGHT,
    FLAPPY_BIRD_SIZE,
    FLAPPY_PIPE_WIDTH,
    FLAPPY_GAP_SIZE,
    FLAPPY_INPUTS,
    FLAPPY_POPULATION_SIZE,
    FlappyGameState,
    FlappyStats,
} from '../types';

const GRAVITY = 0.5;
const JUMP_VELOCITY = -7.5;
const PIPE_SPAWN_INTERVAL = 90; // frames between pipe spawns
const PIPE_SPEED_BASE = 3.0;

interface UseFlappyGameLoopProps {
    computeFlappy: (inputs: Float32Array) => Float32Array | null;
    evolve: (
        fitnessScores: number[],
        mutationRate: number,
        mutationScale: number,
        strategy: wasm.MutationStrategy,
    ) => void;
    setStats: React.Dispatch<React.SetStateAction<FlappyStats>>;
    mutationRate: number;
    mutationScale: number;
    mutationStrategy: wasm.MutationStrategy;
    onGenerationEnd: (maxFitness: number, avgFitness: number) => void;
}

/** Pick a random gap Y such that both top and bottom pipes are visible. */
function randomGap(): { gapTop: number; gapBottom: number } {
    const margin = 60;
    const gapTop = margin + Math.random() * (FLAPPY_HEIGHT - FLAPPY_GAP_SIZE - margin * 2);
    return { gapTop, gapBottom: gapTop + FLAPPY_GAP_SIZE };
}

/**
 * Pure physics hook for the Flappy Bird neuro-evolution demo.
 *
 * Design decisions:
 * - All mutable simulation state lives in `gameState.current` (a ref) to avoid
 *   React re-renders on every frame. Only aggregated stats use setState.
 * - `updateFlappyPhysics` is stable (empty deps) because it reads everything
 *   through the prop-refs pattern — same approach as `useGameLoop`.
 * - Collision is AABB between bird ellipse bounding box and pipe rectangles.
 */
export function useFlappyGameLoop({
    computeFlappy,
    evolve,
    setStats,
    mutationRate,
    mutationScale,
    mutationStrategy,
    onGenerationEnd,
}: UseFlappyGameLoopProps) {
    const gameState = useRef<FlappyGameState>({
        birds: [],
        pipes: [],
        score: 0,
        generation: 1,
        speed: PIPE_SPEED_BASE,
    });

    // Stable refs so updateFlappyPhysics never becomes stale
    const mutationRateRef = useRef(mutationRate);
    const mutationScaleRef = useRef(mutationScale);
    const mutationStrategyRef = useRef(mutationStrategy);
    mutationRateRef.current = mutationRate;
    mutationScaleRef.current = mutationScale;
    mutationStrategyRef.current = mutationStrategy;

    const isComputing = useRef(false);
    const frameCount = useRef(0);

    /** Rebuild all birds at spawn position. Called on first init and after each generation. */
    const resetFlappy = useCallback(() => {
        const state = gameState.current;
        state.birds = Array.from({ length: FLAPPY_POPULATION_SIZE }, (_, i) => ({
            id: i,
            y: FLAPPY_HEIGHT / 2,
            vy: 0,
            dead: false,
            fitness: 0,
            color: `hsl(${(i / FLAPPY_POPULATION_SIZE) * 360}, 75%, 60%)`,
        }));
        state.pipes = [];
        state.score = 0;
        state.speed = PIPE_SPEED_BASE;
        frameCount.current = 0;
        setStats(s => ({ ...s, alive: FLAPPY_POPULATION_SIZE, score: 0 }));
    }, [setStats]);

    /** Called when all birds are dead — run evolution and start next generation. */
    const runEvolution = useCallback(() => {
        const state = gameState.current;
        const scores = state.birds.map(b => b.fitness);
        const maxFitness = Math.max(...scores);
        const avgFitness = scores.reduce((a, b) => a + b, 0) / scores.length;

        try {
            evolve(scores, mutationRateRef.current, mutationScaleRef.current, mutationStrategyRef.current);
            state.generation++;
            setStats(s => ({
                ...s,
                generation: state.generation,
                best: Math.max(s.best, maxFitness),
            }));
            onGenerationEnd(maxFitness, avgFitness);
            resetFlappy();
        } catch (e) {
            console.error('FLAPPY: evolution error:', e);
        }
    }, [evolve, resetFlappy, setStats, onGenerationEnd]);

    /**
     * Core physics + AI tick. Called once per animation frame.
     * Order: spawn → move pipes → build WASM inputs → forward pass → apply jumps → collision.
     */
    const updateFlappyPhysics = useCallback(() => {
        const state = gameState.current;
        const aliveBirds = state.birds.filter(b => !b.dead);

        if (aliveBirds.length === 0) {
            runEvolution();
            return;
        }

        frameCount.current++;
        state.score++;

        // Gradually increase speed each 60 frames
        if (state.score % 60 === 0) {
            state.speed = Math.min(state.speed + 0.05, 8.0);
        }

        // Publish score every 10 frames to avoid React thrashing
        if (state.score % 10 === 0) {
            setStats(prev => ({ ...prev, score: state.score, alive: aliveBirds.length }));
        }

        // Spawn a new pipe pair at regular intervals
        if (frameCount.current % PIPE_SPAWN_INTERVAL === 0) {
            const { gapTop, gapBottom } = randomGap();
            state.pipes.push({
                x: FLAPPY_WIDTH + FLAPPY_PIPE_WIDTH,
                gapTop,
                gapBottom,
                passed: false,
            });
        }

        // Move pipes left, cull off-screen ones
        state.pipes.forEach(p => { p.x -= state.speed; });
        state.pipes = state.pipes.filter(p => p.x + FLAPPY_PIPE_WIDTH > -10);

        // ── Build WASM inputs ─────────────────────────────────────────────────
        //   [0] dy_top   = (bird.y - pipe.gapTop)  / FLAPPY_HEIGHT  (negative = below gap top)
        //   [1] dy_bot   = (pipe.gapBottom - bird.y) / FLAPPY_HEIGHT (negative = above gap bot)
        //   [2] bird_y   = bird.y / FLAPPY_HEIGHT
        //   [3] vy_norm  = bird.vy / 15.0  (approx max velocity)
        //   [4] unused_dummy = 0.0 (WASM backend requires exactly 5 sensors)

        const inputs = new Float32Array(FLAPPY_POPULATION_SIZE * FLAPPY_INPUTS);
        const nextPipe = state.pipes.find(p => p.x + FLAPPY_PIPE_WIDTH > 0) || null;

        state.birds.forEach((bird, idx) => {
            if (bird.dead) return;

            const dyTop = nextPipe
                ? (bird.y - nextPipe.gapTop) / FLAPPY_HEIGHT
                : 0.0;
            const dyBot = nextPipe
                ? (nextPipe.gapBottom - bird.y) / FLAPPY_HEIGHT
                : 1.0;

            inputs[idx * FLAPPY_INPUTS + 0] = dyTop;
            inputs[idx * FLAPPY_INPUTS + 1] = dyBot;
            inputs[idx * FLAPPY_INPUTS + 2] = bird.y / FLAPPY_HEIGHT;
            inputs[idx * FLAPPY_INPUTS + 3] = bird.vy / 15.0;
            inputs[idx * FLAPPY_INPUTS + 4] = 0.0;
        });

        // ── WASM forward pass ─────────────────────────────────────────────────
        if (!isComputing.current) {
            isComputing.current = true;
            try {
                const outputs = computeFlappy(inputs);
                if (outputs) {
                    state.birds.forEach((bird, idx) => {
                        if (bird.dead) return;
                        // >0.5 = jump
                        if (outputs[idx] > 0.5) {
                            bird.vy = JUMP_VELOCITY;
                        }
                    });
                }
            } catch (e) {
                console.error('FLAPPY: WASM compute error:', e);
            } finally {
                isComputing.current = false;
            }
        }

        // ── Apply gravity & move birds ─────────────────────────────────────────
        state.birds.forEach(bird => {
            if (bird.dead) return;
            bird.vy += GRAVITY;
            bird.y += bird.vy;
            bird.fitness += 1; // +1 per frame alive
        });

        // ── Collision detection ───────────────────────────────────────────────
        state.birds.forEach(bird => {
            if (bird.dead) return;

            // Floor and ceiling
            if (bird.y - FLAPPY_BIRD_SIZE / 2 < 0 || bird.y + FLAPPY_BIRD_SIZE / 2 > FLAPPY_HEIGHT) {
                bird.dead = true;
                return;
            }

            // Pipes (AABB)
            for (const pipe of state.pipes) {
                const bLeft = 80; // birds are fixed at x=80
                const bRight = bLeft + FLAPPY_BIRD_SIZE;
                const bTop = bird.y - FLAPPY_BIRD_SIZE / 2;
                const bBottom = bird.y + FLAPPY_BIRD_SIZE / 2;

                const pLeft = pipe.x;
                const pRight = pipe.x + FLAPPY_PIPE_WIDTH;

                // X-axis overlap?
                if (bRight < pLeft || bLeft > pRight) continue;

                // Y-axis: hit if outside gap
                if (bTop < pipe.gapTop || bBottom > pipe.gapBottom) {
                    bird.dead = true;
                    break;
                }

                // Bonus fitness for passing a pipe
                if (!pipe.passed && bRight > pRight) {
                    pipe.passed = true;
                    bird.fitness += 50;
                }
            }
        });
    }, [computeFlappy, runEvolution, setStats]);

    return {
        gameState,
        resetFlappy,
        updateFlappyPhysics,
    };
}
