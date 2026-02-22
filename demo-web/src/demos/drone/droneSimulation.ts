import * as wasm from '../../wasm/pkg/gran_prix_wasm';
import { 
    DRONE_WIDTH, 
    DRONE_HEIGHT, 
    DRONE_POPULATION_SIZE,
    DRONE_INPUTS,
    DRONE_OUTPUTS,
    TARGET_RADIUS,
    DroneStats
} from '../../types';
import { SimulationConfig, SimulationState, BaseAgent } from '../../core/simulation/SimulationEngine';
import { PIDController } from '../../core/physics';

export interface DroneAgent extends BaseAgent {
    x: number;
    y: number;
    vx: number;
    vy: number;
}

export interface PidDrone {
    x: number;
    y: number;
    vx: number;
    vy: number;
    color: string;
    controllerX: PIDController;
    controllerY: PIDController;
}

export interface DroneSimulationState extends SimulationState<DroneAgent> {
    pidDrone: PidDrone;
    targetX: number;
    targetY: number;
    windX: number;
    windY: number;
}

const GRAVITY = 0.2;
const MAX_THRUST = 0.5;
const DRAG = 0.05;

function getRandomTarget() {
    return {
        targetX: DRONE_WIDTH * 0.2 + Math.random() * (DRONE_WIDTH * 0.6),
        targetY: DRONE_HEIGHT * 0.2 + Math.random() * (DRONE_HEIGHT * 0.4),
    };
}

export const droneSimulationConfig: SimulationConfig<DroneAgent, DroneSimulationState, DroneStats> = {
    populations: [
        {
            id: 'drones',
            size: DRONE_POPULATION_SIZE,
            inputs: DRONE_INPUTS,
            outputs: DRONE_OUTPUTS,
            hidden: [12]
        }
    ],

    createAgent: (id, popId) => ({
        id,
        popId,
        x: DRONE_WIDTH / 2,
        y: DRONE_HEIGHT / 2,
        vx: 0,
        vy: 0,
        dead: false,
        fitness: 0,
        color: `hsl(${(id / DRONE_POPULATION_SIZE) * 360}, 75%, 60%)`,
    }),

    onReset: (state) => {
        const target = getRandomTarget();
        state.targetX = target.targetX;
        state.targetY = target.targetY;
        state.windX = 0;
        state.windY = 0;
        state.pidDrone = {
            x: DRONE_WIDTH / 2,
            y: DRONE_HEIGHT / 2,
            vx: 0,
            vy: 0,
            color: 'hsl(30, 100%, 50%)',
            controllerX: new PIDController(0.01, 0.0001, 0.1),
            controllerY: new PIDController(0.01, 0.0001, 0.1)
        };
    },

    getInputs: (state, _popId) => {
        const inputs = new Float32Array(DRONE_POPULATION_SIZE * DRONE_INPUTS);
        state.agents.forEach((drone, idx) => {
            if (drone.dead) return;
            inputs[idx * DRONE_INPUTS + 0] = (state.targetX - drone.x) / (DRONE_WIDTH / 2);
            inputs[idx * DRONE_INPUTS + 1] = (state.targetY - drone.y) / (DRONE_HEIGHT / 2);
            inputs[idx * DRONE_INPUTS + 2] = drone.vx / 10.0;
            inputs[idx * DRONE_INPUTS + 3] = drone.vy / 10.0;
        });
        return inputs;
    },

    updatePhysics: (state, outputsMap) => {
        const outputs = outputsMap.get('drones');

        // Random wind gusts
        if (state.frame % 120 === 0) {
            state.windX = (Math.random() - 0.5) * 0.2;
            state.windY = (Math.random() - 0.5) * 0.1;
        }

        // WASM Drones
        if (outputs) {
            state.agents.forEach((drone, idx) => {
                if (drone.dead) return;
                
                const thrustX = ((outputs[idx * 2 + 0] * 2) - 1) * MAX_THRUST;
                const thrustY = ((outputs[idx * 2 + 1] * 2) - 1) * MAX_THRUST;

                drone.vx += thrustX + state.windX;
                drone.vy += thrustY + state.windY + GRAVITY;
                drone.vx *= (1 - DRAG);
                drone.vy *= (1 - DRAG);
                drone.x += drone.vx;
                drone.y += drone.vy;

                // Fitness
                drone.fitness += 0.1;
                const dist = Math.hypot(drone.x - state.targetX, drone.y - state.targetY);
                if (dist < TARGET_RADIUS * 2) {
                    drone.fitness += (TARGET_RADIUS * 2 - dist) / 10;
                }

                // Boundaries (Bounce)
                if (drone.x < 0) { drone.x = 0; drone.vx *= -0.5; }
                if (drone.x > DRONE_WIDTH) { drone.x = DRONE_WIDTH; drone.vx *= -0.5; }
                if (drone.y < 0) { drone.y = 0; drone.vy *= -0.5; }
                if (drone.y > DRONE_HEIGHT) { drone.y = DRONE_HEIGHT; drone.vy *= -0.5; drone.fitness = Math.max(0, drone.fitness - 1); }
            });
        }

        // PID Drone
        if (state.pidDrone) {
            const p = state.pidDrone;
            const thrustX = p.controllerX.update(state.targetX - p.x);
            const thrustY = p.controllerY.update(state.targetY - p.y) - GRAVITY; // Gravity comp

            p.vx += Math.max(-MAX_THRUST, Math.min(MAX_THRUST, thrustX)) + state.windX;
            p.vy += Math.max(-MAX_THRUST, Math.min(MAX_THRUST, thrustY)) + state.windY + GRAVITY;
            p.vx *= (1 - DRAG);
            p.vy *= (1 - DRAG);
            p.x += p.vx;
            p.y += p.vy;

            // Clamp PID
            p.x = Math.max(0, Math.min(DRONE_WIDTH, p.x));
            p.y = Math.max(0, Math.min(DRONE_HEIGHT, p.y));
        }

        // Check if all are "stale"
        if (state.frame >= 1000) { 
            state.agents.forEach(a => a.dead = true);
        }
    },

    getStats: (state) => ({
        generation: state.generation,
        best: state.agents.length > 0 ? Math.max(...state.agents.map(a => a.fitness)) : 0,
        alive: state.agents.filter(a => !a.dead).length,
        avgFitness: state.agents.length > 0 ? state.agents.reduce((a, b) => a + b.fitness, 0) / state.agents.length : 0,
    }),

    mutationRate: 0.1,
    mutationScale: 0.5,
    mutationStrategy: wasm.MutationStrategy.Additive,
};
