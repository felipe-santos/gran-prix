import { useRef, useCallback } from 'react';
import * as wasm from '../wasm/pkg/gran_prix_wasm';
import {
    TURRET_WIDTH,
    TURRET_HEIGHT,
    TURRET_POPULATION_SIZE,
    TURRET_INPUTS,
    TURRET_OUTPUTS,
    TURRET_MAX_FRAMES,
    GRAVITY,
    PROJECTILE_SPEED,
    DRONE_SPEED_BASE,
    TurretGameState,
    TurretStats
} from '../types';

interface UseTurretGameLoopProps {
    computeAll: (inputs: Float32Array) => Float32Array | null;
    evolve: (fitnessScores: number[], mutationRate: number, mutationScale: number, mutationStrategy: wasm.MutationStrategy) => void;
    setStats: React.Dispatch<React.SetStateAction<TurretStats>>;
    mutationRate: number;
    mutationScale: number;
    mutationStrategy: wasm.MutationStrategy;
}

export function useTurretGameLoop({
    computeAll,
    evolve,
    setStats,
    mutationRate,
    mutationScale,
    mutationStrategy
}: UseTurretGameLoopProps) {
    const gameState = useRef<TurretGameState>({
        generation: 1,
        frame: 0,
        windMagnitude: 0,
        windDirection: 1,
        drone: {
            x: TURRET_WIDTH / 2,
            y: 100,
            baseY: 100,
            vx: DRONE_SPEED_BASE,
            time: 0
        },
        agents: Array.from({ length: TURRET_POPULATION_SIZE }, (_, i) => ({
            id: i,
            popId: 'main',
            dead: false,
            fitness: 0,
            color: `hsl(${Math.random() * 360}, 80%, 50%)`,
            angle: 0, // 0 = pointing straight up
            cooldownTimer: 0,
            projectiles: [],
            hits: 0,
            shotsFired: 0,
            trackingScore: 0
        }))
    });

    const resetGame = useCallback(() => {
        const state = gameState.current;
        state.frame = 0;
        state.windMagnitude = Math.random() * 2; // Random wind 0 to 2
        state.windDirection = Math.random() > 0.5 ? 1 : -1;

        state.drone = {
            x: Math.random() > 0.5 ? 0 : TURRET_WIDTH, // Start left or right
            y: 80 + Math.random() * 100,
            baseY: 80 + Math.random() * 100,
            vx: (Math.random() > 0.5 ? 1 : -1) * (DRONE_SPEED_BASE + Math.random() * 2),
            time: 0
        };

        state.agents.forEach(agent => {
            agent.dead = false;
            agent.fitness = 0;
            agent.angle = 0;
            agent.cooldownTimer = 0;
            agent.projectiles = [];
            agent.hits = 0;
            agent.shotsFired = 0;
            agent.trackingScore = 0;
        });

        setStats(prev => ({ ...prev, alive: TURRET_POPULATION_SIZE }));
    }, [setStats]);

    const updatePhysics = useCallback(() => {
        const state = gameState.current;
        state.frame++;

        // 1. Update Drone
        state.drone.time += 0.05;
        state.drone.x += state.drone.vx;
        state.drone.y = state.drone.baseY + Math.sin(state.drone.time) * 50; // Wavy flight path

        // Bounce drone off walls
        if (state.drone.x < 0 || state.drone.x > TURRET_WIDTH) {
            state.drone.vx *= -1;
        }

        // Change wind occasionally
        if (state.frame % 200 === 0) {
            state.windMagnitude = Math.random() * 3;
            state.windDirection = Math.random() > 0.5 ? 1 : -1;
        }

        // 2. Prepare Inputs for WASM
        // DroneX, DroneY, DroneVX, Wind, TurretAngle, Cooldown
        const inputs = new Float32Array(TURRET_POPULATION_SIZE * TURRET_INPUTS);
        for (let i = 0; i < TURRET_POPULATION_SIZE; i++) {
            const agent = state.agents[i];
            const offset = i * TURRET_INPUTS;
            // Normalize inputs
            inputs[offset + 0] = state.drone.x / TURRET_WIDTH;
            inputs[offset + 1] = state.drone.y / TURRET_HEIGHT;
            inputs[offset + 2] = state.drone.vx / 10.0;
            inputs[offset + 3] = (state.windMagnitude * state.windDirection) / 5.0;
            inputs[offset + 4] = agent.angle / Math.PI; // Normalized angle
            inputs[offset + 5] = agent.cooldownTimer > 0 ? 1 : 0;
        }

        // 3. Run Inference
        const outputs = computeAll(inputs);
        if (!outputs) return;

        // 4. Apply Actions & Physics
        let bestTrackingFrame = 0;
        let totalHitsFrame = 0;

        const TURRET_X = TURRET_WIDTH / 2;
        const TURRET_Y = TURRET_HEIGHT - 40;

        for (let i = 0; i < TURRET_POPULATION_SIZE; i++) {
            const agent = state.agents[i];
            if (agent.dead) continue;

            const motorSpeed = outputs[i * TURRET_OUTPUTS + 0]; // -1 to 1
            const fireTrigger = outputs[i * TURRET_OUTPUTS + 1];

            // Update Turret Angle
            agent.angle += motorSpeed * 0.05; // Max turn speed
            // Clamp angle between -PI/2 (left flat) and PI/2 (right flat)
            agent.angle = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, agent.angle));

            // Cooldown Management
            if (agent.cooldownTimer > 0) {
                agent.cooldownTimer--;
            }

            // Firing Logic
            if (fireTrigger > 0.5 && agent.cooldownTimer <= 0) {
                agent.projectiles.push({
                    x: TURRET_X,
                    y: TURRET_Y,
                    // Angle 0 is straight UP, so vy is -cos(angle), vx is sin(angle)
                    vx: Math.sin(agent.angle) * PROJECTILE_SPEED,
                    vy: -Math.cos(agent.angle) * PROJECTILE_SPEED,
                    active: true
                });
                agent.cooldownTimer = 30; // Cannot fire for 30 frames
                agent.shotsFired++;
            }

            // Track how well the turret is pointing at the drone
            const dx = state.drone.x - TURRET_X;
            const dy = state.drone.y - TURRET_Y;
            const targetAngle = Math.atan2(dx, -dy); // Angle relative to straight up

            const angleDiff = Math.abs(targetAngle - agent.angle);
            if (angleDiff < 0.1) {
                agent.trackingScore += 1; // Reward for precise tracking
            }

            // Update Projectiles
            for (const proj of agent.projectiles) {
                if (!proj.active) continue;

                proj.vy += GRAVITY;
                proj.vx += (state.windMagnitude * state.windDirection) * 0.05; // Wind effect

                proj.x += proj.vx;
                proj.y += proj.vy;

                // Check out of bounds
                if (proj.x < 0 || proj.x > TURRET_WIDTH || proj.y > TURRET_HEIGHT) {
                    proj.active = false;
                    agent.fitness -= 2; // Punishment for missing
                }

                // Check collision with drone
                const distToDrone = Math.hypot(proj.x - state.drone.x, proj.y - state.drone.y);
                if (distToDrone < 20) { // Drone hit radius
                    proj.active = false;
                    agent.hits++;
                    agent.fitness += 1000; // Massive reward for hit

                    // Reset drone for everyone after a hit?
                    // Actually, let's keep it simple: one global drone. If ANY hits it, it explodes for that frame,
                    // but we just count it as a hit and let it keep flying so other agents can also learn simultaneously.
                    // To prevent infinite farming, we could reset the drone state, but it affects all agents.
                    // For now, reward the hit but don't despawn the drone.
                }
            }

            // Clean inactive projectiles
            agent.projectiles = agent.projectiles.filter(p => p.active);

            // Accumulate Fitness
            agent.fitness += (1 - angleDiff / Math.PI) * 0.5; // Constant minor reward for facing the right general direction

            if (agent.trackingScore > bestTrackingFrame) bestTrackingFrame = agent.trackingScore;
            totalHitsFrame += agent.hits;
        }

        setStats(prev => ({
            ...prev,
            score: state.frame, // Just use frame as score progression
            bestTracking: bestTrackingFrame,
            totalHits: totalHitsFrame
        }));

        // 5. Check Generation End
        if (state.frame >= TURRET_MAX_FRAMES) {
            const fitness = state.agents.map(a => Math.max(0.1, a.fitness)); // No negative fitness
            const highestFit = Math.max(...fitness);

            setStats(prev => ({ ...prev, best: Math.max(prev.best, highestFit) }));

            // Evolve
            evolve(fitness, mutationRate, mutationScale, mutationStrategy);

            state.generation++;
            setStats(prev => ({ ...prev, generation: state.generation }));
            resetGame();
        }

    }, [computeAll, evolve, setStats, mutationRate, mutationScale, mutationStrategy, resetGame]);

    return { gameState, resetGame, updatePhysics };
}
