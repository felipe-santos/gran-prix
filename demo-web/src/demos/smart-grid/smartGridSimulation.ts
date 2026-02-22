import * as wasm from '../../wasm/pkg/gran_prix_wasm';
import {
    GRID_POPULATION_SIZE,
    GRID_INPUTS,
    GRID_OUTPUTS,
    GRID_MAX_FRAMES,
    GRID_BATTERY_CAPACITY,
    GRID_PEAK_SOLAR,
    GRID_BATTERY_EFFICIENCY,
} from '../../types';
import { SimulationConfig, SimulationState, BaseAgent } from '../../core/simulation/SimulationEngine';

export interface GridAgent extends BaseAgent {
    batterySoC: number;
    totalCost: number;
    totalRevenue: number;
}

export interface GridSimulationState extends SimulationState<GridAgent> {
    env: {
        hour: number;
        solarOutput: number;
        houseDemand: number;
        gridPrice: number;
        cloudCover: number;
    };
    generation: number;
}

export interface GridStats {
    generation: number;
    best: number;
    avgCost: number;
    avgFitness: number;
    alive: number;
}

// ─── Internal Helpers (Copied from useSmartGridGameLoop.ts) ──────────────────

function houseDemandAt(hour: number): number {
    const base = 0.5;
    const morningPeak = 2.0 * Math.exp(-0.5 * ((hour - 7.5) / 1.2) ** 2);
    const eveningPeak = 3.0 * Math.exp(-0.5 * ((hour - 19.5) / 1.8) ** 2);
    return base + morningPeak + eveningPeak;
}

function solarOutputAt(hour: number, cloudCover: number): number {
    if (hour < 5.5 || hour > 19.5) return 0;
    const raw = Math.sin(Math.PI * (hour - 5.5) / 14.0);
    return Math.max(0, raw * GRID_PEAK_SOLAR * (1 - cloudCover * 0.75));
}

function gridPriceAt(hour: number): number {
    if (hour < 6 || hour >= 22) return 0.08;
    if (hour >= 6 && hour < 10) return 0.15;
    if (hour >= 10 && hour < 17) return 0.12;
    if (hour >= 17 && hour < 21) return 0.30;
    return 0.15;
}

function sellPriceAt(hour: number): number {
    return gridPriceAt(hour) * 0.4;
}

function priceTrend(hour: number): number {
    const nextHour = (hour + 1) % 24;
    return (gridPriceAt(nextHour) - gridPriceAt(hour)) / 0.30;
}

function solarForecast(hour: number, cloudCover: number): number {
    const nextHour = Math.min(hour + 1, 23.99);
    return solarOutputAt(nextHour, cloudCover) / GRID_PEAK_SOLAR;
}

export const smartGridSimulationConfig: SimulationConfig<GridAgent, GridSimulationState, GridStats> = {
    populations: [
        {
            id: 'grid',
            size: GRID_POPULATION_SIZE,
            inputs: GRID_INPUTS,
            outputs: GRID_OUTPUTS,
            hidden: [16, 12]
        }
    ],

    mutationRate: 0.15,
    mutationScale: 0.5,
    mutationStrategy: wasm.MutationStrategy.Additive,

    createAgent: (id, popId) => ({
        id,
        popId,
        batterySoC: 0.5,
        totalCost: 0,
        totalRevenue: 0,
        fitness: 0,
        dead: false,
        color: `hsl(${(id / GRID_POPULATION_SIZE) * 120 + 100}, 70%, 55%)`
    }),

    onReset: (state) => {
        state.env = {
            hour: 0,
            solarOutput: 0,
            houseDemand: houseDemandAt(0),
            gridPrice: gridPriceAt(0),
            cloudCover: Math.random() * 0.5
        };
    },

    getInputs: (state, _popId) => {
        const inputs = new Float32Array(GRID_POPULATION_SIZE * GRID_INPUTS);
        const hourRad = (2 * Math.PI * state.env.hour) / 24.0;

        for (let i = 0; i < GRID_POPULATION_SIZE; i++) {
            const agent = state.agents[i];
            const base = i * GRID_INPUTS;
            inputs[base + 0] = state.env.solarOutput / GRID_PEAK_SOLAR;
            inputs[base + 1] = state.env.houseDemand / 4.0;
            inputs[base + 2] = agent.batterySoC;
            inputs[base + 3] = state.env.gridPrice / 0.30;
            inputs[base + 4] = Math.sin(hourRad);
            inputs[base + 5] = Math.cos(hourRad);
            inputs[base + 6] = priceTrend(state.env.hour);
            inputs[base + 7] = solarForecast(state.env.hour, state.env.cloudCover);
        }
        return inputs;
    },

    updatePhysics: (state, outputsMap) => {
        const outputs = outputsMap.get('grid');
        if (!outputs) return;

        const dt = 1 / 60;
        for (let i = 0; i < state.agents.length; i++) {
            const agent = state.agents[i];
            if (agent.dead) continue;

            const base = i * GRID_OUTPUTS;
            const cS = outputs[base + 0]; 
            const dS = outputs[base + 1]; 
            const sS = outputs[base + 2];
            
            let action: 'charge' | 'discharge' | 'sell';
            if (cS >= dS && cS >= sS) action = 'charge';
            else if (dS >= cS && dS >= sS) action = 'discharge';
            else action = 'sell';

            const surplus = state.env.solarOutput - state.env.houseDemand;
            if (action === 'charge') {
                if (surplus > 0) {
                    const amount = Math.min(surplus * dt, (1 - agent.batterySoC) * GRID_BATTERY_CAPACITY);
                    agent.batterySoC += (amount * GRID_BATTERY_EFFICIENCY) / GRID_BATTERY_CAPACITY;
                } else {
                    agent.totalCost += (-surplus) * dt * state.env.gridPrice;
                    const gridCharge = Math.min(1.0 * dt, (1 - agent.batterySoC) * GRID_BATTERY_CAPACITY);
                    agent.totalCost += gridCharge * state.env.gridPrice;
                    agent.batterySoC += (gridCharge * GRID_BATTERY_EFFICIENCY) / GRID_BATTERY_CAPACITY;
                }
            } else if (action === 'discharge') {
                if (surplus < 0) {
                    const deficit = -surplus;
                    const discharge = Math.min(deficit * dt, agent.batterySoC * GRID_BATTERY_CAPACITY);
                    agent.batterySoC -= discharge / GRID_BATTERY_CAPACITY;
                    const remaining = deficit * dt - discharge;
                    if (remaining > 0) agent.totalCost += remaining * state.env.gridPrice;
                }
            } else {
                if (surplus > 0) agent.totalRevenue += surplus * dt * sellPriceAt(state.env.hour);
                else agent.totalCost += (-surplus) * dt * state.env.gridPrice;
            }

            agent.batterySoC = Math.max(0, Math.min(1, agent.batterySoC));
            const netCost = agent.totalCost - agent.totalRevenue;
            agent.fitness = Math.max(0, 10.0 - netCost + agent.batterySoC * 0.5);
        }

        // Advance environment
        state.env.hour = (state.frame / GRID_MAX_FRAMES) * 24.0;
        state.env.cloudCover = Math.max(0, Math.min(1, state.env.cloudCover + (Math.random() - 0.5) * 0.01));
        state.env.solarOutput = solarOutputAt(state.env.hour, state.env.cloudCover);
        state.env.houseDemand = houseDemandAt(state.env.hour);
        state.env.gridPrice = gridPriceAt(state.env.hour);

        if (state.frame >= GRID_MAX_FRAMES) {
            // Engine handles evolution if we return a flag or if we just let it happen.
            // In the current engine, tick() doesn't check for completion, it just advances frame.
            // But if all dead it evolves. We can force evolution by killing everyone or adding a completion check.
            state.agents.forEach(a => a.dead = true);
        }
    },

    getStats: (state) => {
        const avgCost = state.agents.length > 0 ? state.agents.reduce((s, a) => s + a.totalCost, 0) / state.agents.length : 0;
        const avgFitness = state.agents.length > 0 ? state.agents.reduce((s, a) => s + a.fitness, 0) / state.agents.length : 0;
        const best = state.agents.length > 0 ? Math.max(...state.agents.map(a => a.fitness)) : 0;
        return {
            generation: state.generation,
            best,
            avgCost,
            avgFitness,
            alive: state.agents.filter(a => !a.dead).length
        };
    }
};
