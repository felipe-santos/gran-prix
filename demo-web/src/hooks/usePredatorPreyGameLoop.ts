import { useCallback, useRef } from 'react';
import * as wasm from '../wasm/pkg/gran_prix_wasm';
import {
    PREDATOR_PREY_WIDTH,
    PREDATOR_PREY_HEIGHT,
    PREDATOR_POPULATION_SIZE,
    PREY_POPULATION_SIZE,
    PREDATOR_INPUTS,
    PREDATOR_OUTPUTS,
    PREY_INPUTS,
    PREY_OUTPUTS,
    PREDATOR_SIZE,
    PREY_SIZE,
    PREDATOR_PREY_MAX_FRAMES,
    PredatorPreyGameState,
    PredatorPreyStats,
    PredatorAgent,
    PreyAgent
} from '../types';

const MAX_SPEED_PREDATOR = 3.5;
const MAX_SPEED_PREY = 4.0; // Rabbits are slightly faster but have less stamina
const TURN_SPEED = 0.15;
const EAT_DISTANCE = (PREDATOR_SIZE + PREY_SIZE) / 2;

// Energy costs
const PREDATOR_ENERGY_DRAIN = 0.002;
const PREDATOR_EAT_ENERGY = 0.5;
const PREY_ENERGY_DRAIN = 0.001;
const PREY_REST_REGEN = 0.005;

interface UsePredatorPreyGameLoopProps {
    computePredator: (inputs: Float32Array) => Float32Array | null;
    computePrey: (inputs: Float32Array) => Float32Array | null;
    evolvePredator: (fitness: number[], rate: number, scale: number, strategy: wasm.MutationStrategy) => void;
    evolvePrey: (fitness: number[], rate: number, scale: number, strategy: wasm.MutationStrategy) => void;
    setStats: React.Dispatch<React.SetStateAction<PredatorPreyStats>>;
    mutationRate: number;
    mutationScale: number;
    mutationStrategy: wasm.MutationStrategy;
    onGenerationEnd: (predatorMax: number, predatorAvg: number, preyMax: number, preyAvg: number) => void;
}

function normalizeAngle(angle: number): number {
    while (angle > Math.PI) angle -= Math.PI * 2;
    while (angle < -Math.PI) angle += Math.PI * 2;
    return angle;
}

export function usePredatorPreyGameLoop({
    computePredator,
    computePrey,
    evolvePredator,
    evolvePrey,
    setStats,
    mutationRate,
    mutationScale,
    mutationStrategy,
    onGenerationEnd
}: UsePredatorPreyGameLoopProps) {
    const gameState = useRef<PredatorPreyGameState>({
        predators: [],
        prey: [],
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

    const resetSimulation = useCallback(() => {
        const state = gameState.current;
        
        state.predators = Array.from({ length: PREDATOR_POPULATION_SIZE }, (_, i) => ({
            id: i,
            x: Math.random() * PREDATOR_PREY_WIDTH,
            y: Math.random() * PREDATOR_PREY_HEIGHT,
            vx: (Math.random() - 0.5) * 2,
            vy: (Math.random() - 0.5) * 2,
            energy: 1.0,
            fitness: 0,
            dead: false,
            color: `hsl(15, 80%, ${50 + Math.random() * 20}%)` // Orange/Red foxes
        }));

        state.prey = Array.from({ length: PREY_POPULATION_SIZE }, (_, i) => ({
            id: i,
            x: Math.random() * PREDATOR_PREY_WIDTH,
            y: Math.random() * PREDATOR_PREY_HEIGHT,
            vx: (Math.random() - 0.5) * 2,
            vy: (Math.random() - 0.5) * 2,
            energy: 1.0,
            fitness: 0,
            dead: false,
            color: `hsl(210, 20%, ${70 + Math.random() * 30}%)` // White/Grey/Blue rabbits
        }));

        state.frame = 0;
        setStats(s => ({
            ...s,
            predatorsAlive: PREDATOR_POPULATION_SIZE,
            preyAlive: PREY_POPULATION_SIZE
        }));
    }, [setStats]);

    const runEvolution = useCallback(() => {
        const state = gameState.current;
        
        const predatorScores = state.predators.map(p => p.fitness);
        const preyScores = state.prey.map(p => p.fitness);

        const predMax = Math.max(...predatorScores);
        const predAvg = predatorScores.reduce((a, b) => a + b, 0) / predatorScores.length;

        const preyMax = Math.max(...preyScores);
        const preyAvg = preyScores.reduce((a, b) => a + b, 0) / preyScores.length;

        try {
            evolvePredator(
                predatorScores,
                mutationRateRef.current,
                mutationScaleRef.current,
                mutationStrategyRef.current
            );
            evolvePrey(
                preyScores,
                mutationRateRef.current,
                mutationScaleRef.current,
                mutationStrategyRef.current
            );

            state.generation++;
            setStats(s => ({
                ...s,
                generation: state.generation,
                predatorBest: Math.max(s.predatorBest, predMax),
                preyBest: Math.max(s.preyBest, preyMax),
            }));

            onGenerationEnd(predMax, predAvg, preyMax, preyAvg);
            resetSimulation();
        } catch (e) {
            console.error('Co-Evolution error:', e);
        }
    }, [evolvePredator, evolvePrey, resetSimulation, setStats, onGenerationEnd]);

    const updatePhysics = useCallback(() => {
        const state = gameState.current;
        const alivePredators = state.predators.filter(p => !p.dead);
        const alivePrey = state.prey.filter(p => !p.dead);

        // End conditions: All prey dead, all predators dead, or time limit reached
        if (alivePrey.length === 0 || alivePredators.length === 0 || state.frame >= PREDATOR_PREY_MAX_FRAMES) {
            runEvolution();
            return;
        }

        state.frame++;

        // Update stats
        if (state.frame % 10 === 0) {
            setStats(prev => ({
                ...prev,
                predatorsAlive: alivePredators.length,
                preyAlive: alivePrey.length
            }));
        }

        // ─── 1. Build Inputs ──────────────────────────────────────────────────
        
        const predInputs = new Float32Array(PREDATOR_POPULATION_SIZE * PREDATOR_INPUTS);
        state.predators.forEach((pred, idx) => {
            if (pred.dead) return;
            
            // Find nearest prey
            let minDist = Infinity;
            let nearestPrey: PreyAgent | null = null;
            
            for (const prey of alivePrey) {
                const dx = prey.x - pred.x;
                const dy = prey.y - pred.y;
                // Toroidal distance (wrap around world for vision isn't needed if we use hard walls, 
                // but let's just use Euclidean for a walled arena)
                const dist = Math.sqrt(dx*dx + dy*dy);
                if (dist < minDist) {
                    minDist = dist;
                    nearestPrey = prey;
                }
            }

            const heading = Math.atan2(pred.vy, pred.vx);

            let angleToPrey = 0;
            let distNorm = 1.0;

            if (nearestPrey) {
                const globalAngle = Math.atan2(nearestPrey.y - pred.y, nearestPrey.x - pred.x);
                angleToPrey = normalizeAngle(globalAngle - heading) / Math.PI; // [-1, 1]
                distNorm = Math.min(minDist / PREDATOR_PREY_WIDTH, 1.0);
            }

            // Dist to wall
            const distLeft = pred.x;
            const distRight = PREDATOR_PREY_WIDTH - pred.x;
            const distTop = pred.y;
            const distBottom = PREDATOR_PREY_HEIGHT - pred.y;
            const distWall = Math.min(distLeft, distRight, distTop, distBottom);
            const wallNorm = Math.min(distWall / 200, 1.0); // normalize up to 200px

            const speed = Math.sqrt(pred.vx*pred.vx + pred.vy*pred.vy);

            const offset = idx * PREDATOR_INPUTS;
            predInputs[offset + 0] = distNorm;
            predInputs[offset + 1] = angleToPrey;
            predInputs[offset + 2] = pred.vx / MAX_SPEED_PREDATOR;
            predInputs[offset + 3] = pred.vy / MAX_SPEED_PREDATOR;
            predInputs[offset + 4] = wallNorm;
            predInputs[offset + 5] = pred.energy;
            predInputs[offset + 6] = 1.0; // bias
        });

        const preyInputs = new Float32Array(PREY_POPULATION_SIZE * PREY_INPUTS);
        state.prey.forEach((prey, idx) => {
            if (prey.dead) return;

            // Find nearest predator
            let minDistT = Infinity;
            let nearestPred: PredatorAgent | null = null;
            
            for (const pred of alivePredators) {
                const dx = pred.x - prey.x;
                const dy = pred.y - prey.y;
                const dist = Math.sqrt(dx*dx + dy*dy);
                if (dist < minDistT) {
                    minDistT = dist;
                    nearestPred = pred;
                }
            }

            // Find nearest flock member (other prey)
            let minFlockDist = Infinity;
            for (const other of alivePrey) {
                if (other.id === prey.id) continue;
                const dx = other.x - prey.x;
                const dy = other.y - prey.y;
                const dist = Math.sqrt(dx*dx + dy*dy);
                if (dist < minFlockDist) {
                    minFlockDist = dist;
                }
            }

            const heading = Math.atan2(prey.vy, prey.vx);

            let angleToPred = 0;
            let distNorm = 1.0;

            if (nearestPred) {
                const globalAngle = Math.atan2(nearestPred.y - prey.y, nearestPred.x - prey.x);
                angleToPred = normalizeAngle(globalAngle - heading) / Math.PI; // [-1, 1]
                distNorm = Math.min(minDistT / PREDATOR_PREY_WIDTH, 1.0);
            }

            const flockNorm = minFlockDist === Infinity ? 1.0 : Math.min(minFlockDist / 200.0, 1.0);

            // Dist to wall
            const distLeft = prey.x;
            const distRight = PREDATOR_PREY_WIDTH - prey.x;
            const distTop = prey.y;
            const distBottom = PREDATOR_PREY_HEIGHT - prey.y;
            const distWall = Math.min(distLeft, distRight, distTop, distBottom);
            const wallNorm = Math.min(distWall / 200, 1.0);

            const offset = idx * PREY_INPUTS;
            preyInputs[offset + 0] = distNorm;
            preyInputs[offset + 1] = angleToPred;
            preyInputs[offset + 2] = prey.vx / MAX_SPEED_PREY;
            preyInputs[offset + 3] = prey.vy / MAX_SPEED_PREY;
            preyInputs[offset + 4] = wallNorm;
            preyInputs[offset + 5] = prey.energy;
            preyInputs[offset + 6] = flockNorm;
        });

        // ─── 2. WASM Compute ──────────────────────────────────────────────────
        if (!isComputing.current) {
            isComputing.current = true;
            try {
                const predOutputs = computePredator(predInputs);
                if (predOutputs) {
                    state.predators.forEach((pred, idx) => {
                        if (pred.dead) return;
                        
                        const thrust = predOutputs[idx * PREDATOR_OUTPUTS + 0];     // [0, 1]
                        const turn = (predOutputs[idx * PREDATOR_OUTPUTS + 1] * 2) - 1; // [-1, 1]

                        const heading = Math.atan2(pred.vy, pred.vx) + turn * TURN_SPEED;
                        
                        // Apply thrust if energy > 0
                        const actualThrust = pred.energy > 0 ? thrust * MAX_SPEED_PREDATOR : thrust * (MAX_SPEED_PREDATOR * 0.3);
                        
                        pred.vx = Math.cos(heading) * actualThrust;
                        pred.vy = Math.sin(heading) * actualThrust;

                        pred.energy = Math.max(0, pred.energy - (thrust * PREDATOR_ENERGY_DRAIN) - 0.0001);
                    });
                }

                const preyOutputs = computePrey(preyInputs);
                if (preyOutputs) {
                    state.prey.forEach((prey, idx) => {
                        if (prey.dead) return;

                        const thrust = preyOutputs[idx * PREY_OUTPUTS + 0];
                        const turn = (preyOutputs[idx * PREY_OUTPUTS + 1] * 2) - 1;

                        const heading = Math.atan2(prey.vy, prey.vx) + turn * TURN_SPEED;
                        
                        // Energy system for prey: sprinting costs energy, slow movement regains
                        let actualThrust = thrust * MAX_SPEED_PREY;
                        if (prey.energy <= 0) actualThrust *= 0.3; // exhausted

                        prey.vx = Math.cos(heading) * actualThrust;
                        prey.vy = Math.sin(heading) * actualThrust;

                        if (thrust > 0.5) {
                            prey.energy -= PREY_ENERGY_DRAIN * thrust;
                        } else {
                            prey.energy += PREY_REST_REGEN;
                        }
                        prey.energy = Math.max(0, Math.min(1, prey.energy));
                    });
                }
            } catch (e) {
                console.error('Compute error:', e);
            } finally {
                isComputing.current = false;
            }
        }

        // ─── 3. Move & Resolve Physics ────────────────────────────────────────
        
        state.predators.forEach(pred => {
            if (pred.dead) return;
            pred.x += pred.vx;
            pred.y += pred.vy;

            // Bounce off walls
            if (pred.x < PREDATOR_SIZE) { pred.x = PREDATOR_SIZE; pred.vx *= -1; }
            if (pred.x > PREDATOR_PREY_WIDTH - PREDATOR_SIZE) { pred.x = PREDATOR_PREY_WIDTH - PREDATOR_SIZE; pred.vx *= -1; }
            if (pred.y < PREDATOR_SIZE) { pred.y = PREDATOR_SIZE; pred.vy *= -1; }
            if (pred.y > PREDATOR_PREY_HEIGHT - PREDATOR_SIZE) { pred.y = PREDATOR_PREY_HEIGHT - PREDATOR_SIZE; pred.vy *= -1; }

            // Survival fitness
            pred.fitness += 0.02;
            
            // Starvation
            if (pred.energy <= 0 && Math.random() < 0.005) {
                pred.dead = true; 
                pred.color = '#333'; // Desaturate
            }
        });

        state.prey.forEach(prey => {
            if (prey.dead) return;
            prey.x += prey.vx;
            prey.y += prey.vy;

            // Bounce off walls
            if (prey.x < PREY_SIZE) { prey.x = PREY_SIZE; prey.vx *= -1; }
            if (prey.x > PREDATOR_PREY_WIDTH - PREY_SIZE) { prey.x = PREDATOR_PREY_WIDTH - PREY_SIZE; prey.vx *= -1; }
            if (prey.y < PREY_SIZE) { prey.y = PREY_SIZE; prey.vy *= -1; }
            if (prey.y > PREDATOR_PREY_HEIGHT - PREY_SIZE) { prey.y = PREDATOR_PREY_HEIGHT - PREY_SIZE; prey.vy *= -1; }

            // Survival fitness
            prey.fitness += 1.0;
        });

        // ─── 4. Collision Detection (Eating) ──────────────────────────────────

        state.predators.forEach(pred => {
            if (pred.dead) return;
            
            state.prey.forEach(prey => {
                if (prey.dead) return;

                const dx = pred.x - prey.x;
                const dy = pred.y - prey.y;
                if (dx*dx + dy*dy < EAT_DISTANCE * EAT_DISTANCE) {
                    // Pred eats Prey
                    prey.dead = true;
                    prey.color = '#333';
                    
                    pred.fitness += 1500; // Big reward for eating
                    pred.energy = Math.min(1.0, pred.energy + PREDATOR_EAT_ENERGY);
                }
            });
        });

    }, [computePredator, computePrey, runEvolution, setStats]);

    return {
        gameState,
        resetSimulation,
        updatePhysics
    };
}
