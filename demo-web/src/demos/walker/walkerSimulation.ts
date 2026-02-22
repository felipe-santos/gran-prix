import * as planck from 'planck-js';
import * as wasm from '../../wasm/pkg/gran_prix_wasm';
import {
    WALKER_POPULATION_SIZE,
    WALKER_INPUTS,
    WALKER_OUTPUTS,
    WALKER_MAX_FRAMES,
} from '../../types/walker';
import {
    WalkerBody,
    createWalkerWorld,
    createWalkerBody,
    getWalkerInputs,
    applyWalkerOutputs,
    isWalkerDead,
    computeWalkerFitness,
} from '../../lib/walkerPhysics';
import { SimulationConfig, SimulationState, BaseAgent } from '../../core/simulation/SimulationEngine';

export interface WalkerAgent extends BaseAgent {
    distance: number;
}

export interface WalkerSimulationState extends SimulationState<WalkerAgent> {
    world: planck.World | null;
    walkers: WalkerBody[];
    framesAlive: number[];
}

export interface WalkerStats {
    generation: number;
    best: number;
    alive: number;
    avgDistance: number;
}

export const walkerSimulationConfig: SimulationConfig<WalkerAgent, WalkerSimulationState, WalkerStats> = {
    populations: [
        {
            id: 'walkers',
            size: WALKER_POPULATION_SIZE,
            inputs: WALKER_INPUTS,
            outputs: WALKER_OUTPUTS,
            hidden: [16, 12],
        }
    ],

    mutationRate: 0.1,
    mutationScale: 0.2,
    mutationStrategy: wasm.MutationStrategy.Additive,

    createAgent: (id, popId) => ({
        id,
        popId,
        distance: 0,
        dead: false,
        fitness: 0,
        color: `hsl(${(id / WALKER_POPULATION_SIZE) * 360}, 75%, 60%)`,
    }),

    onReset: (state) => {
        state.world = createWalkerWorld();
        state.walkers = [];
        state.framesAlive = new Array(WALKER_POPULATION_SIZE).fill(0);
        
        for (let i = 0; i < state.agents.length; i++) {
            const spawnX = 2 + i * 0.05;
            state.walkers.push(createWalkerBody(state.world, spawnX, i));
        }
    },

    getInputs: (state, _popId) => {
        const inputs = new Float32Array(WALKER_POPULATION_SIZE * WALKER_INPUTS);
        for (let i = 0; i < state.agents.length; i++) {
            if (state.agents[i].dead) continue;
            const sensorValues = getWalkerInputs(state.walkers[i]);
            for (let j = 0; j < WALKER_INPUTS; j++) {
                inputs[i * WALKER_INPUTS + j] = sensorValues[j];
            }
        }
        return inputs;
    },

    updatePhysics: (state, outputsMap) => {
        if (!state.world) return;
        const outputs = outputsMap.get('walkers');

        // Step physics
        state.world.step(1/60, 6, 2);

        for (let i = 0; i < state.agents.length; i++) {
            const agent = state.agents[i];
            if (agent.dead) continue;

            // Apply brain outputs
            if (outputs) {
                const agentOutputs: number[] = [];
                for (let j = 0; j < WALKER_OUTPUTS; j++) {
                    agentOutputs.push(outputs[i * WALKER_OUTPUTS + j]);
                }
                applyWalkerOutputs(state.walkers[i], agentOutputs);
            }

            // Update distance and check death
            state.framesAlive[i]++;
            
            if (isWalkerDead(state.walkers[i])) {
                agent.dead = true;
                agent.fitness = computeWalkerFitness(state.walkers[i], state.framesAlive[i]);
                // Put bodies to sleep
                state.walkers[i].torso.setActive(false);
                state.walkers[i].upperLegL.setActive(false);
                state.walkers[i].lowerLegL.setActive(false);
                state.walkers[i].upperLegR.setActive(false);
                state.walkers[i].lowerLegR.setActive(false);
            } else {
                agent.distance = state.walkers[i].torso.getPosition().x - state.walkers[i].spawnX;
                agent.fitness = agent.distance; // Real-time fitness
            }
        }

        if (state.frame >= WALKER_MAX_FRAMES) {
            state.agents.forEach((a, i) => {
                if (!a.dead) {
                    a.dead = true;
                    a.fitness = computeWalkerFitness(state.walkers[i], state.framesAlive[i]);
                }
            });
        }
    },

    getStats: (state) => {
        const aliveCount = state.agents.filter(a => !a.dead).length;
        const totalDistance = state.agents.reduce((sum, a) => sum + (a.dead ? a.fitness : a.distance), 0);
        const bestFitness = state.agents.length > 0 ? Math.max(...state.agents.map(a => a.fitness)) : 0;

        return {
            generation: state.generation,
            best: bestFitness,
            alive: aliveCount,
            avgDistance: state.agents.length > 0 ? totalDistance / state.agents.length : 0,
        };
    }
};
