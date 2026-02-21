import { useCallback, useRef } from 'react';
import * as wasm from '../wasm/pkg/gran_prix_wasm';
import {
    DRONE_WIDTH,
    DRONE_HEIGHT,
    DRONE_POPULATION_SIZE,
    DRONE_INPUTS,
    DroneGameState,
    DroneStats,
    TARGET_RADIUS,
    DRONE_MAX_FRAMES
} from '../types';

const GRAVITY = 0.2;
const MAX_THRUST = 0.5; // Max acceleration per frame
const DRAG = 0.05; // Air resistance

// PID Constants
const Kp = 0.01;
const Ki = 0.0001;
const Kd = 0.1;

interface UseDroneGameLoopProps {
    computeDrone: (inputs: Float32Array) => Float32Array | null;
    evolve: (
        fitnessScores: number[],
        mutationRate: number,
        mutationScale: number,
        strategy: wasm.MutationStrategy,
    ) => void;
    setStats: React.Dispatch<React.SetStateAction<DroneStats>>;
    mutationRate: number;
    mutationScale: number;
    mutationStrategy: wasm.MutationStrategy;
    onGenerationEnd: (maxFitness: number, avgFitness: number) => void;
}

function getRandomTarget() {
    return {
        targetX: DRONE_WIDTH * 0.2 + Math.random() * (DRONE_WIDTH * 0.6),
        targetY: DRONE_HEIGHT * 0.2 + Math.random() * (DRONE_HEIGHT * 0.4),
    };
}

export function useDroneGameLoop({
    computeDrone,
    evolve,
    setStats,
    mutationRate,
    mutationScale,
    mutationStrategy,
    onGenerationEnd,
}: UseDroneGameLoopProps) {
    const { targetX, targetY } = getRandomTarget();

    const gameState = useRef<DroneGameState>({
        drones: [],
        pidDrone: {
            x: DRONE_WIDTH / 2, y: DRONE_HEIGHT - 50, vx: 0, vy: 0,
            integralX: 0, integralY: 0, prevErrorX: 0, prevErrorY: 0, color: 'hsl(30, 100%, 50%)' // Orange PID
        },
        targetX,
        targetY,
        windX: 0,
        windY: 0,
        frame: 0,
        generation: 1,
    });

    const mutationRateRef = useRef(mutationRate);
    const mutationScaleRef = useRef(mutationScale);
    const mutationStrategyRef = useRef(mutationStrategy);
    mutationRateRef.current = mutationRate;
    mutationScaleRef.current = mutationScale;
    mutationStrategyRef.current = mutationStrategy;

    const isComputing = useRef(false);

    const resetDrone = useCallback(() => {
        const state = gameState.current;
        const target = getRandomTarget();
        state.targetX = target.targetX;
        state.targetY = target.targetY;
        
        state.windX = (Math.random() - 0.5) * 0.1; // Initial slight wind
        state.windY = (Math.random() - 0.5) * 0.05;

        state.drones = Array.from({ length: DRONE_POPULATION_SIZE }, (_, i) => ({
            id: i,
            x: DRONE_WIDTH / 2,
            y: DRONE_HEIGHT / 2, // Start in middle to avoid instant death from gravity
            vx: 0,
            vy: 0,
            dead: false,
            fitness: 0,
            color: `hsl(${(i / DRONE_POPULATION_SIZE) * 360}, 75%, 60%)`,
        }));

        state.pidDrone = {
            ...state.pidDrone,
            x: DRONE_WIDTH / 2, y: DRONE_HEIGHT / 2, vx: 0, vy: 0,
            integralX: 0, integralY: 0, prevErrorX: 0, prevErrorY: 0
        };

        state.frame = 0;
        setStats(s => ({ ...s, alive: DRONE_POPULATION_SIZE }));
    }, [setStats]);

    const runEvolution = useCallback(() => {
        const state = gameState.current;
        const scores = state.drones.map(d => d.fitness);
        if (scores.length === 0) return; // Guard against evolving empty array before first reset
        
        const maxFitness = Math.max(...scores);
        const avgFitness = scores.reduce((a, b) => a + b, 0) / scores.length;

        try {
            evolve(scores, mutationRateRef.current, mutationScaleRef.current, mutationStrategyRef.current);
            state.generation++;
            setStats(s => ({
                ...s,
                generation: state.generation,
                best: Math.max(s.best, maxFitness),
                avgFitness
            }));
            onGenerationEnd(maxFitness, avgFitness);
            resetDrone();
        } catch (e) {
            console.error('DRONE: evolution error:', e);
        }
    }, [evolve, resetDrone, setStats, onGenerationEnd]);

    const updateDronePhysics = useCallback(() => {
        const state = gameState.current;
        const aliveDrones = state.drones.filter(d => !d.dead);

        if (aliveDrones.length === 0 || state.frame >= DRONE_MAX_FRAMES) {
            runEvolution();
            return;
        }

        state.frame++;

        if (state.frame % 10 === 0) {
            setStats(prev => ({ ...prev, alive: aliveDrones.length }));
        }

        // Random wind gusts every 120 frames
        if (state.frame % 120 === 0) {
            state.windX = (Math.random() - 0.5) * 0.2;
            state.windY = (Math.random() - 0.5) * 0.1;
        }

        // ── WASM Inputs ─────────────────────────────────────────────────
        const inputs = new Float32Array(DRONE_POPULATION_SIZE * DRONE_INPUTS);

        state.drones.forEach((drone, idx) => {
            if (drone.dead) return;
            // distBoxX: (-1 to 1) 
            inputs[idx * DRONE_INPUTS + 0] = (state.targetX - drone.x) / (DRONE_WIDTH / 2);
            inputs[idx * DRONE_INPUTS + 1] = (state.targetY - drone.y) / (DRONE_HEIGHT / 2);
            inputs[idx * DRONE_INPUTS + 2] = drone.vx / 10.0;
            inputs[idx * DRONE_INPUTS + 3] = drone.vy / 10.0;
        });

        // ── WASM Forward Pass ─────────────────────────────────────────────────
        if (!isComputing.current) {
            isComputing.current = true;
            try {
                const outputs = computeDrone(inputs);
                if (outputs) {
                    state.drones.forEach((drone, idx) => {
                        if (drone.dead) return;
                        
                        // outputs mapped to [-1, 1] for thrust X and thrust Y
                        const outX = (outputs[idx * 2 + 0] * 2) - 1;
                        const outY = (outputs[idx * 2 + 1] * 2) - 1;

                        const thrustX = outX * MAX_THRUST;
                        const thrustY = outY * MAX_THRUST;

                        drone.vx += thrustX;
                        drone.vy += thrustY; // thrustY can be negative (upwards)
                    });
                }
            } catch (e) {
                console.error('DRONE: WASM compute error:', e);
            } finally {
                isComputing.current = false;
            }
        }

        // ── PID Control Pass ─────────────────────────────────────────────────
        const errorX = state.targetX - state.pidDrone.x;
        const errorY = state.targetY - state.pidDrone.y;

        state.pidDrone.integralX += errorX;
        state.pidDrone.integralY += errorY;

        const derivativeX = errorX - state.pidDrone.prevErrorX;
        const derivativeY = errorY - state.pidDrone.prevErrorY;

        // compute desired force
        const forceX = Kp * errorX + Ki * state.pidDrone.integralX + Kd * derivativeX;
        // Gravity compensation + PID force
        const forceY = Kp * errorY + Ki * state.pidDrone.integralY + Kd * derivativeY - GRAVITY;

        // Clamp thrust
        const pidThrustX = Math.max(-MAX_THRUST, Math.min(MAX_THRUST, forceX));
        const pidThrustY = Math.max(-MAX_THRUST, Math.min(MAX_THRUST, forceY));

        state.pidDrone.vx += pidThrustX;
        state.pidDrone.vy += pidThrustY;

        state.pidDrone.prevErrorX = errorX;
        state.pidDrone.prevErrorY = errorY;


        // ── Physics Integration ───────────────────────────────────────────────
        state.drones.forEach(drone => {
            if (drone.dead) return;

            drone.vx += state.windX;
            drone.vy += state.windY + GRAVITY;

            // Drag
            drone.vx *= (1 - DRAG);
            drone.vy *= (1 - DRAG);

            drone.x += drone.vx;
            drone.y += drone.vy;

            // Fitness: Baseline for surviving, plus bonus if inside target ring
            drone.fitness += 0.1;
            const dist = Math.hypot(drone.x - state.targetX, drone.y - state.targetY);
            if (dist < TARGET_RADIUS * 2) {
                drone.fitness += (TARGET_RADIUS * 2 - dist) / 10;
            }

            // Boundaries (Bounce instead of instant death, but penalize fitness slightly)
            if (drone.x < 0) { drone.x = 0; drone.vx *= -0.5; }
            if (drone.x > DRONE_WIDTH) { drone.x = DRONE_WIDTH; drone.vx *= -0.5; }
            if (drone.y < 0) { drone.y = 0; drone.vy *= -0.5; }
            if (drone.y > DRONE_HEIGHT) { drone.y = DRONE_HEIGHT; drone.vy *= -0.5; drone.fitness = Math.max(0, drone.fitness - 1); }
        });

        // PID integration
        state.pidDrone.vx += state.windX;
        state.pidDrone.vy += state.windY + GRAVITY;
        state.pidDrone.vx *= (1 - DRAG);
        state.pidDrone.vy *= (1 - DRAG);
        state.pidDrone.x += state.pidDrone.vx;
        state.pidDrone.y += state.pidDrone.vy;
        
        // Boundaries for PID (just clamp it so it doesn't fly away irreversibly)
        state.pidDrone.x = Math.max(0, Math.min(DRONE_WIDTH, state.pidDrone.x));
        state.pidDrone.y = Math.max(0, Math.min(DRONE_HEIGHT, state.pidDrone.y));

    }, [computeDrone, runEvolution, setStats]);

    return {
        gameState,
        resetDrone,
        updateDronePhysics,
    };
}
