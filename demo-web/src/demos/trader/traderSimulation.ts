import * as wasm from '../../wasm/pkg/gran_prix_wasm';
import {
    TRADER_POPULATION_SIZE,
    TRADER_INPUTS,
    TRADER_OUTPUTS,
    TRADER_MAX_FRAMES,
    TRADER_INITIAL_CAPITAL,
    TRADER_FEE_RATE,
    Candle,
} from '../../types';
import { SimulationConfig, SimulationState, BaseAgent } from '../../core/simulation/SimulationEngine';

export interface TraderAgent extends BaseAgent {
    capital: number;
    position: -1 | 0 | 1;
    entryPrice: number;
    peakCapital: number;
    maxDrawdown: number;
    tradeCount: number;
}

export interface TraderSimulationState extends SimulationState<TraderAgent> {
    env: {
        candles: Candle[];
        currentPrice: number;
        rsi: number;
        smaCrossover: number;
        atr: number;
        tick: number;
    };
    bestTrades: { tick: number; action: 'buy' | 'sell'; price: number }[];
}

export interface TraderStats {
    generation: number;
    bestROI: number;
    avgROI: number;
    bestDrawdown: number;
    alive: number;
}

// ─── Internal Helpers (Copied from useTraderGameLoop.ts) ──────────────────────

function generatePriceSeries(numCandles: number, startPrice: number): Candle[] {
    const mu = 0.0002; const sigma = 0.015;
    const candles: Candle[] = [];
    let price = startPrice;
    for (let i = 0; i < numCandles; i++) {
        const open = price;
        const z1 = boxMullerRandom(); const z2 = boxMullerRandom(); const z3 = boxMullerRandom();
        const move1 = price * Math.exp((mu - sigma * sigma / 2) + sigma * z1);
        const move2 = price * Math.exp((mu - sigma * sigma / 2) + sigma * z2);
        const close = price * Math.exp((mu - sigma * sigma / 2) + sigma * z3);
        const high = Math.max(open, close, move1, move2);
        const low = Math.min(open, close, move1, move2);
        candles.push({ open, high, low, close });
        price = close;
    }
    return candles;
}

function boxMullerRandom(): number {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function computeRSI(candles: Candle[], period: number, endIdx: number): number {
    if (endIdx < period) return 50;
    let gains = 0, losses = 0;
    for (let i = endIdx - period + 1; i <= endIdx; i++) {
        const change = candles[i].close - candles[i - 1].close;
        if (change > 0) gains += change; else losses -= change;
    }
    if (losses === 0) return 100;
    const rs = (gains / period) / (losses / period);
    return 100 - 100 / (1 + rs);
}

function computeSMA(candles: Candle[], period: number, endIdx: number): number {
    if (endIdx < period - 1) return candles[endIdx].close;
    let sum = 0;
    for (let i = endIdx - period + 1; i <= endIdx; i++) sum += candles[i].close;
    return sum / period;
}

function computeATR(candles: Candle[], period: number, endIdx: number): number {
    if (endIdx < 1) return 0;
    const start = Math.max(1, endIdx - period + 1);
    let sum = 0; let count = 0;
    for (let i = start; i <= endIdx; i++) {
        const tr = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close));
        sum += tr; count++;
    }
    return count > 0 ? sum / count : 0;
}

export const traderSimulationConfig: SimulationConfig<TraderAgent, TraderSimulationState, TraderStats> = {
    populations: [
        {
            id: 'traders',
            size: TRADER_POPULATION_SIZE,
            inputs: TRADER_INPUTS,
            outputs: TRADER_OUTPUTS,
            hidden: [12, 8]
        }
    ],

    mutationRate: 0.18,
    mutationScale: 0.5,
    mutationStrategy: wasm.MutationStrategy.Additive,

    createAgent: (id, popId) => ({
        id,
        popId,
        capital: TRADER_INITIAL_CAPITAL,
        position: 0,
        entryPrice: 0,
        peakCapital: TRADER_INITIAL_CAPITAL,
        maxDrawdown: 0,
        tradeCount: 0,
        fitness: 0,
        dead: false,
        color: `hsl(${(id / TRADER_POPULATION_SIZE) * 60 + 200}, 70%, 55%)`
    }),

    onReset: (state) => {
        const startPrice = 80 + Math.random() * 40;
        const candles = generatePriceSeries(TRADER_MAX_FRAMES, startPrice);
        state.env = {
            candles,
            currentPrice: candles[0].close,
            rsi: 50,
            smaCrossover: 0,
            atr: 0,
            tick: 0
        };
        state.bestTrades = [];
    },

    getInputs: (state, _popId) => {
        const candle = state.env.candles[state.frame];
        const prevPrice = state.frame > 0 ? state.env.candles[state.frame - 1].close : (candle?.open || 100);
        const logReturn = Math.log((candle?.close || prevPrice) / prevPrice);

        const inputs = new Float32Array(TRADER_POPULATION_SIZE * TRADER_INPUTS);
        for (let i = 0; i < TRADER_POPULATION_SIZE; i++) {
            const agent = state.agents[i];
            const base = i * TRADER_INPUTS;
            let openPnL = 0;
            if (agent.position !== 0) {
                openPnL = agent.position === 1 ? (state.env.currentPrice - agent.entryPrice) / agent.entryPrice : (agent.entryPrice - state.env.currentPrice) / agent.entryPrice;
            }
            const currentDD = agent.peakCapital > 0 ? (agent.peakCapital - agent.capital) / agent.peakCapital : 0;
            inputs[base + 0] = logReturn * 100;
            inputs[base + 1] = (state.env.rsi - 50) / 50;
            inputs[base + 2] = state.env.smaCrossover * 100;
            inputs[base + 3] = (state.env.currentPrice > 0 ? state.env.atr / state.env.currentPrice : 0) * 100;
            inputs[base + 4] = agent.position;
            inputs[base + 5] = Math.tanh(openPnL * 10);
            inputs[base + 6] = currentDD;
        }
        return inputs;
    },

    updatePhysics: (state, outputsMap) => {
        const outputs = outputsMap.get('traders');
        if (!outputs) return;

        const candle = state.env.candles[state.frame];
        if (!candle) return;

        state.env.currentPrice = candle.close;
        state.env.tick = state.frame;
        state.env.rsi = computeRSI(state.env.candles, 7, state.frame);
        const sma7 = computeSMA(state.env.candles, 7, state.frame);
        const sma25 = computeSMA(state.env.candles, 25, state.frame);
        state.env.smaCrossover = (sma7 - sma25) / state.env.currentPrice;
        state.env.atr = computeATR(state.env.candles, 7, state.frame);

        for (let i = 0; i < state.agents.length; i++) {
            const agent = state.agents[i];
            if (agent.dead) continue;

            const base = i * TRADER_OUTPUTS;
            const buyS = outputs[base + 0]; 
            const sellS = outputs[base + 1]; 
            const holdS = outputs[base + 2];
            
            let action: 'buy' | 'sell' | 'hold';
            if (buyS >= sellS && buyS >= holdS) action = 'buy';
            else if (sellS >= buyS && sellS >= holdS) action = 'sell';
            else action = 'hold';

            if (action === 'buy' && agent.position !== 1) {
                if (agent.position === -1) {
                    const pnl = (agent.entryPrice - state.env.currentPrice) / agent.entryPrice;
                    agent.capital *= (1 + pnl); agent.capital *= (1 - TRADER_FEE_RATE);
                }
                agent.position = 1; agent.entryPrice = state.env.currentPrice; agent.capital *= (1 - TRADER_FEE_RATE); agent.tradeCount++;
                if (i === 0) state.bestTrades.push({ tick: state.frame, action: 'buy', price: state.env.currentPrice });
            } else if (action === 'sell' && agent.position !== -1) {
                if (agent.position === 1) {
                    const pnl = (state.env.currentPrice - agent.entryPrice) / agent.entryPrice;
                    agent.capital *= (1 + pnl); agent.capital *= (1 - TRADER_FEE_RATE);
                }
                agent.position = -1; agent.entryPrice = state.env.currentPrice; agent.capital *= (1 - TRADER_FEE_RATE); agent.tradeCount++;
                if (i === 0) state.bestTrades.push({ tick: state.frame, action: 'sell', price: state.env.currentPrice });
            }

            if (agent.capital > agent.peakCapital) agent.peakCapital = agent.capital;
            const dd = (agent.peakCapital - agent.capital) / agent.peakCapital;
            if (dd > agent.maxDrawdown) agent.maxDrawdown = dd;
            if (agent.capital < TRADER_INITIAL_CAPITAL * 0.1) agent.dead = true;

            // Updated fitness: ROI penalized by Drawdown
            const roi = agent.capital / TRADER_INITIAL_CAPITAL;
            const ddPenalty = 1 - agent.maxDrawdown;
            agent.fitness = Math.max(0, roi * ddPenalty);
        }

        if (state.frame >= TRADER_MAX_FRAMES) {
            // Force settlement at end of period
            state.agents.forEach(a => {
                if (a.position !== 0 && !a.dead) {
                    const finalPrice = state.env.currentPrice;
                    const pnl = a.position === 1 ? (finalPrice - a.entryPrice) / a.entryPrice : (a.entryPrice - finalPrice) / a.entryPrice;
                    a.capital *= (1 + pnl); a.capital *= (1 - TRADER_FEE_RATE);
                }
                a.dead = true;
            });
        }
    },

    getStats: (state) => {
        const avgROI = state.agents.length > 0 ? state.agents.reduce((s, a) => s + a.capital / TRADER_INITIAL_CAPITAL, 0) / state.agents.length : 1;
        const bestROI = state.agents.length > 0 ? Math.max(...state.agents.map(a => a.capital / TRADER_INITIAL_CAPITAL)) : 1;
        const bestDrawdown = state.agents.length > 0 ? [...state.agents].sort((a,b) => b.capital - a.capital)[0].maxDrawdown : 0;
        return {
            generation: state.generation,
            bestROI,
            avgROI,
            bestDrawdown,
            alive: state.agents.filter(a => !a.dead).length
        };
    }
};
