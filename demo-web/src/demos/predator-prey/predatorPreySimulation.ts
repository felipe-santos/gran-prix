import * as wasm from '../../wasm/pkg/gran_prix_wasm';
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
    PredatorPreyStats,
} from '../../types';
import { SimulationConfig, SimulationState, BaseAgent } from '../../core/simulation/SimulationEngine';

export interface PredatorPreyAgent extends BaseAgent {
    x: number;
    y: number;
    vx: number;
    vy: number;
    energy: number;
}

export interface PredatorPreySimulationState extends SimulationState<PredatorPreyAgent> {
    // Additional state if needed
}

const MAX_SPEED_PREDATOR = 3.5;
const MAX_SPEED_PREY = 4.0;
const TURN_SPEED = 0.15;
const PREDATOR_ENERGY_DRAIN = 0.002;
const PREDATOR_EAT_ENERGY = 0.5;
const PREY_ENERGY_DRAIN = 0.001;
const PREY_REST_REGEN = 0.005;

function normalizeAngle(angle: number): number {
    while (angle > Math.PI) angle -= Math.PI * 2;
    while (angle < -Math.PI) angle += Math.PI * 2;
    return angle;
}

export const predatorPreySimulationConfig: SimulationConfig<PredatorPreyAgent, PredatorPreySimulationState, PredatorPreyStats> = {
    populations: [
        {
            id: 'predators',
            size: PREDATOR_POPULATION_SIZE,
            inputs: PREDATOR_INPUTS,
            outputs: PREDATOR_OUTPUTS,
            hidden: [12, 8]
        },
        {
            id: 'prey',
            size: PREY_POPULATION_SIZE,
            inputs: PREY_INPUTS,
            outputs: PREY_OUTPUTS,
            hidden: [12, 8]
        }
    ],

    createAgent: (id, popId) => {
        const isPred = popId === 'predators';
        return {
            id,
            popId,
            x: Math.random() * PREDATOR_PREY_WIDTH,
            y: Math.random() * PREDATOR_PREY_HEIGHT,
            vx: (Math.random() - 0.5) * 2,
            vy: (Math.random() - 0.5) * 2,
            energy: 1.0,
            fitness: 0,
            dead: false,
            color: isPred 
                ? `hsl(15, 80%, ${50 + Math.random() * 20}%)` 
                : `hsl(210, 20%, ${70 + Math.random() * 30}%)`
        };
    },

    getInputs: (state, popId) => {
        const isPred = popId === 'predators';
        const numInputs = isPred ? PREDATOR_INPUTS : PREY_INPUTS;
        const popSize = isPred ? PREDATOR_POPULATION_SIZE : PREY_POPULATION_SIZE;
        const inputs = new Float32Array(popSize * numInputs);
        
        const popAgents = state.agents.filter(a => a.popId === popId);
        const opponents = state.agents.filter(a => a.popId !== popId && !a.dead);
        const friends = state.agents.filter(a => a.popId === popId && !a.dead);

        popAgents.forEach((agent, idx) => {
            if (agent.dead) return;

            // Find nearest opponent
            let minDist = Infinity;
            let nearestOpponent: PredatorPreyAgent | null = null;
            for (const opp of opponents) {
                const dx = opp.x - agent.x;
                const dy = opp.y - agent.y;
                const d = Math.sqrt(dx*dx + dy*dy);
                if (d < minDist) {
                    minDist = d;
                    nearestOpponent = opp;
                }
            }

            const heading = Math.atan2(agent.vy, agent.vx);
            let angleToOpp = 0;
            let distNorm = 1.0;

            if (nearestOpponent) {
                const globalAngle = Math.atan2(nearestOpponent.y - agent.y, nearestOpponent.x - agent.x);
                angleToOpp = normalizeAngle(globalAngle - heading) / Math.PI;
                distNorm = Math.min(minDist / PREDATOR_PREY_WIDTH, 1.0);
            }

            // Dist to wall
            const wallDist = Math.min(agent.x, PREDATOR_PREY_WIDTH - agent.x, agent.y, PREDATOR_PREY_HEIGHT - agent.y);
            const wallNorm = Math.min(wallDist / 200, 1.0);

            const offset = idx * numInputs;
            inputs[offset + 0] = distNorm;
            inputs[offset + 1] = angleToOpp;
            inputs[offset + 2] = agent.vx / (isPred ? MAX_SPEED_PREDATOR : MAX_SPEED_PREY);
            inputs[offset + 3] = agent.vy / (isPred ? MAX_SPEED_PREDATOR : MAX_SPEED_PREY);
            inputs[offset + 4] = wallNorm;
            inputs[offset + 5] = agent.energy;
            
            if (isPred) {
                inputs[offset + 6] = 1.0; // bias
            } else {
                // Flock norm for prey
                let minFlockDist = Infinity;
                for (const friend of friends) {
                    if (friend.id === agent.id) continue;
                    const d = Math.sqrt((friend.x - agent.x)**2 + (friend.y - agent.y)**2);
                    if (d < minFlockDist) minFlockDist = d;
                }
                inputs[offset + 6] = minFlockDist === Infinity ? 1.0 : Math.min(minFlockDist / 200.0, 1.0);
                
                // Fitness reward for surviving
                agent.fitness += 1.0 + (distNorm * 5.0);
            }
        });
        
        return inputs;
    },

    updatePhysics: (state, outputsMap) => {
        const predOutputs = outputsMap.get('predators');
        const preyOutputs = outputsMap.get('prey');

        const predators = state.agents.filter(a => a.popId === 'predators');
        const prey = state.agents.filter(a => a.popId === 'prey');

        // Update Predators
        predators.forEach((pred, idx) => {
            if (pred.dead) return;
            if (predOutputs) {
                const thrust = predOutputs[idx * PREDATOR_OUTPUTS + 0];
                const turn = (predOutputs[idx * PREDATOR_OUTPUTS + 1] * 2) - 1;
                const heading = Math.atan2(pred.vy, pred.vx) + turn * TURN_SPEED;
                const speed = pred.energy > 0 ? thrust * MAX_SPEED_PREDATOR : thrust * (MAX_SPEED_PREDATOR * 0.3);
                pred.vx = Math.cos(heading) * speed;
                pred.vy = Math.sin(heading) * speed;
                pred.energy = Math.max(0, pred.energy - (thrust * PREDATOR_ENERGY_DRAIN) - 0.0001);
            }
            pred.x += pred.vx;
            pred.y += pred.vy;
            // Wall bounce
            if (pred.x < PREDATOR_SIZE) { pred.x = PREDATOR_SIZE; pred.vx *= -1; }
            if (pred.x > PREDATOR_PREY_WIDTH - PREDATOR_SIZE) { pred.x = PREDATOR_PREY_WIDTH - PREDATOR_SIZE; pred.vx *= -1; }
            if (pred.y < PREDATOR_SIZE) { pred.y = PREDATOR_SIZE; pred.vy *= -1; }
            if (pred.y > PREDATOR_PREY_HEIGHT - PREDATOR_SIZE) { pred.y = PREDATOR_PREY_HEIGHT - PREDATOR_SIZE; pred.vy *= -1; }
            
            pred.fitness += 0.02;
            if (pred.energy <= 0 && Math.random() < 0.005) pred.dead = true;
        });

        // Update Prey
        prey.forEach((p, idx) => {
            if (p.dead) return;
            if (preyOutputs) {
                const thrust = preyOutputs[idx * PREY_OUTPUTS + 0];
                const turn = (preyOutputs[idx * PREY_OUTPUTS + 1] * 2) - 1;
                const heading = Math.atan2(p.vy, p.vx) + turn * TURN_SPEED;
                let speed = thrust * MAX_SPEED_PREY;
                if (p.energy <= 0) speed *= 0.3;
                p.vx = Math.cos(heading) * speed;
                p.vy = Math.sin(heading) * speed;
                if (thrust > 0.5) p.energy -= PREY_ENERGY_DRAIN * thrust;
                else p.energy += PREY_REST_REGEN;
                p.energy = Math.max(0, Math.min(1, p.energy));
            }
            p.x += p.vx;
            p.y += p.vy;
            // Wall bounce
            if (p.x < PREY_SIZE) { p.x = PREY_SIZE; p.vx *= -1; }
            if (p.x > PREDATOR_PREY_WIDTH - PREY_SIZE) { p.x = PREDATOR_PREY_WIDTH - PREY_SIZE; p.vx *= -1; }
            if (p.y < PREY_SIZE) { p.y = PREY_SIZE; p.vy *= -1; }
            if (p.y > PREDATOR_PREY_HEIGHT - PREY_SIZE) { p.y = PREDATOR_PREY_HEIGHT - PREY_SIZE; p.vy *= -1; }
        });

        // Eating collisions
        const EAT_DIST_SQ = ((PREDATOR_SIZE + PREY_SIZE) / 2) ** 2;
        predators.forEach(pred => {
            if (pred.dead) return;
            prey.forEach(p => {
                if (p.dead) return;
                const dx = pred.x - p.x;
                const dy = pred.y - p.y;
                if (dx*dx + dy*dy < EAT_DIST_SQ) {
                    p.dead = true;
                    pred.fitness += 1500;
                    pred.energy = Math.min(1.0, pred.energy + PREDATOR_EAT_ENERGY);
                }
            });
        });

        // Check end condition
        const alivePrey = prey.filter(p => !p.dead).length;
        const alivePreds = predators.filter(p => !p.dead).length;
        if (alivePrey === 0 || alivePreds === 0 || state.frame >= PREDATOR_PREY_MAX_FRAMES) {
            state.agents.forEach(a => a.dead = true);
        }
    },

    getStats: (state) => {
        const predators = state.agents.filter(a => a.popId === 'predators');
        const prey = state.agents.filter(a => a.popId === 'prey');
        return {
            generation: state.generation,
            predatorsAlive: predators.filter(a => !a.dead).length,
            preyAlive: prey.filter(a => !a.dead).length,
            predatorBest: predators.length > 0 ? Math.max(...predators.map(a => a.fitness)) : 0,
            preyBest: prey.length > 0 ? Math.max(...prey.map(a => a.fitness)) : 0,
        };
    },

    mutationRate: 0.1,
    mutationScale: 0.5,
    mutationStrategy: wasm.MutationStrategy.Additive,
};
