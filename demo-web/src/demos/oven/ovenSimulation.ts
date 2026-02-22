import * as wasm from '../../wasm/pkg/gran_prix_wasm';
import { 
    OVEN_POPULATION_SIZE, 
    OVEN_INPUTS, 
    OVEN_OUTPUTS,
    OVEN_AMBIENT_TEMP,
    OVEN_MAX_TEMP,
    OVEN_MAX_FRAMES,
    OVEN_FOODS,
    OvenFoodType,
    OvenStats,
    OvenAgent
} from '../../types/oven';
import { SimulationConfig, SimulationState } from '../../core/simulation/SimulationEngine';

export interface OvenSimulationState extends SimulationState<OvenAgent> {
    currentFoodType: OvenFoodType;
    restingFrames: number;
}

const getNextFoodType = (current: OvenFoodType): OvenFoodType => {
    const types = Object.values(OvenFoodType);
    const currentIndex = types.indexOf(current);
    const nextIndex = (currentIndex + 1) % types.length;
    return types[nextIndex];
};

export const ovenSimulationConfig: SimulationConfig<OvenAgent, OvenSimulationState, OvenStats> = {
    populations: [
        {
            id: 'ovens',
            size: OVEN_POPULATION_SIZE,
            inputs: OVEN_INPUTS,
            outputs: OVEN_OUTPUTS,
            hidden: [12, 8]
        }
    ],
    createAgent: (id, popId) => ({
        id,
        popId,
        fitness: 0,
        dead: false,
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
        food: OVEN_FOODS[OvenFoodType.Cake], // Will be updated in onReset
        color: `hsl(${(id / OVEN_POPULATION_SIZE) * 200 + 40}, 70%, 55%)`,
    }),

    onReset: (state) => {
        if (state.generation === 1 && !state.currentFoodType) {
            state.currentFoodType = OvenFoodType.Cake;
        } else {
            state.currentFoodType = getNextFoodType(state.currentFoodType || OvenFoodType.Cake);
        }
        
        const foodProfile = OVEN_FOODS[state.currentFoodType];
        state.agents.forEach(a => {
            a.food = foodProfile;
            a.airTemp = OVEN_AMBIENT_TEMP;
            a.surfaceTemp = OVEN_AMBIENT_TEMP;
            a.coreTemp = OVEN_AMBIENT_TEMP;
            a.moisture = 1.0;
            a.cooked = false;
            a.burnt = false;
            a.energyUsed = 0;
            a.dead = false;
        });
        state.restingFrames = 0;
    },

    getInputs: (state, _popId) => {
        const inputs = new Float32Array(OVEN_POPULATION_SIZE * OVEN_INPUTS);
        state.agents.forEach((agent, i) => {
            if (agent.burnt || agent.cooked) return;
            const f = agent.food;
            const base = i * OVEN_INPUTS;

            inputs[base + 0] = agent.airTemp / OVEN_MAX_TEMP;
            inputs[base + 1] = agent.surfaceTemp / OVEN_MAX_TEMP;
            inputs[base + 2] = agent.coreTemp / OVEN_MAX_TEMP;
            inputs[base + 3] = Math.max(0, (f.targetCore - agent.coreTemp) / 100.0);
            inputs[base + 4] = Math.max(0, (f.burnTemp - agent.surfaceTemp) / 100.0);
            inputs[base + 5] = state.frame / OVEN_MAX_FRAMES;
            inputs[base + 6] = f.type === OvenFoodType.Cake ? 1 : 0;
            inputs[base + 7] = f.type === OvenFoodType.Bread ? 1 : 0;
            inputs[base + 8] = f.type === OvenFoodType.Turkey ? 1 : 0;
            inputs[base + 9] = f.type === OvenFoodType.Pizza ? 1 : 0;
            inputs[base + 10] = agent.moisture;
        });
        return inputs;
    },

    updatePhysics: (state, outputsMap) => {
        const outputs = outputsMap.get('ovens');

        const activeAgents = state.agents.filter(a => !a.burnt && !a.cooked);
        if (activeAgents.length === 0) {
            state.restingFrames = (state.restingFrames || 0) + 1;
        }

        // Early exit if done
        if ((activeAgents.length === 0 && (state.restingFrames || 0) > 300) || state.frame >= OVEN_MAX_FRAMES) {
            state.agents.forEach(a => a.dead = true);
            // Evolution will happen automatically when all agents are dead
            // We need a way to change the food type for the next generation.
            // We can do it AFTER evolution or in a lifecycle hook.
            // Since we don't have an after-evolve hook yet, we'll do it on frame 0 of next gen.
            return;
        }

        state.agents.forEach((agent, i) => {
            const isDone = agent.burnt || agent.cooked;
            if (isDone) {
                agent.topHeater = 0;
                agent.bottomHeater = 0;
                agent.fan = 0;
            } else if (outputs) {
                const outBase = i * OVEN_OUTPUTS;
                agent.topHeater = Math.max(0, Math.min(1, outputs[outBase + 0]));
                agent.bottomHeater = Math.max(0, Math.min(1, outputs[outBase + 1]));
                agent.fan = outputs[outBase + 2] > 0.5 ? 1.0 : 0.0;
                agent.energyUsed += agent.topHeater + agent.bottomHeater + (agent.fan * 0.3);
            }

            const f = agent.food;
            const heaterPower = (agent.topHeater * 2.0) + (agent.bottomHeater * 1.5);
            const heatingDelta = heaterPower * 0.1; 
            const coolingDelta = (agent.airTemp - OVEN_AMBIENT_TEMP) * 0.0012;
            agent.airTemp += heatingDelta - coolingDelta;
            agent.airTemp = Math.max(OVEN_AMBIENT_TEMP, Math.min(OVEN_MAX_TEMP, agent.airTemp));

            const fanMultiplier = agent.fan === 1.0 ? 1.5 : 1.0;
            const surfaceDelta = (agent.airTemp - agent.surfaceTemp) * f.surfaceConductivity * fanMultiplier * 0.01;
            const radiationDelta = agent.topHeater * 0.1;
            agent.surfaceTemp += surfaceDelta + radiationDelta;
            agent.surfaceTemp = Math.max(OVEN_AMBIENT_TEMP, agent.surfaceTemp);

            const coreDelta = (agent.surfaceTemp - agent.coreTemp) * f.coreConductivity * 0.01;
            agent.coreTemp += coreDelta;
            agent.coreTemp = Math.max(OVEN_AMBIENT_TEMP, agent.coreTemp);

            if (agent.surfaceTemp > 100) {
                agent.moisture -= (agent.surfaceTemp - 100) * f.moistureLossRate * 0.0001;
                agent.moisture = Math.max(0, agent.moisture);
            }

            if (!isDone) {
                if (agent.surfaceTemp >= f.burnTemp) {
                    agent.burnt = true;
                } else if (agent.coreTemp >= f.targetCore) {
                    agent.cooked = true;
                }

                // Fitness
                let fit = (agent.coreTemp - OVEN_AMBIENT_TEMP) * 2;
                if (agent.burnt) {
                    fit = fit * 0.6;
                }
                if (agent.cooked && !agent.burnt) {
                    fit += 500;
                    fit += agent.moisture * 200;
                    const timePenalty = (state.frame / OVEN_MAX_FRAMES) * 50;
                    const energyPenalty = agent.energyUsed * 0.05;
                    fit -= (timePenalty + energyPenalty);
                }
                agent.fitness = Math.max(0, fit);
            }
        });

        // Trigger mutation of food type for next gen on frame 1 of next gen?
        // Actually, let's do it in evolve or something.
        // Since we can't easily hook into evolve, we'll check if generation changed.
    },

    getStats: (state) => {
        const scores = state.agents.map(a => a.fitness);
        const maxFitness = scores.length > 0 ? Math.max(...scores) : 0;
        const avgFitness = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
        const successes = state.agents.filter(a => a.cooked && !a.burnt).length;

        // Note: successRates per food type is hard to track in this generic way without full state management
        // but we can provide the current gen's stats.
        return {
            generation: state.generation,
            bestFitness: maxFitness,
            avgFitness,
            bestCoreTemp: Math.max(...state.agents.map(a => a.coreTemp)),
            successRates: {
                [OvenFoodType.Cake]: 0,
                [OvenFoodType.Bread]: 0,
                [OvenFoodType.Turkey]: 0,
                [OvenFoodType.Pizza]: 0,
                [state.currentFoodType]: (successes / OVEN_POPULATION_SIZE) * 100
            }
        };
    },

    mutationRate: 0.15,
    mutationScale: 0.4,
    mutationStrategy: wasm.MutationStrategy.Additive,
};
