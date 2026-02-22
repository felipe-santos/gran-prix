import { useCallback, useRef } from 'react';
import * as wasm from '../wasm/pkg/gran_prix_wasm';
import {
    TRADER_POPULATION_SIZE,
    TRADER_INPUTS,
    TRADER_OUTPUTS,
    TRADER_MAX_FRAMES,
    TRADER_INITIAL_CAPITAL,
    TRADER_FEE_RATE,
    Candle,
    TraderGameState,
    TraderStats,
} from '../types';

// ─── Price Generation (Geometric Brownian Motion) ────────────────────────────

function generatePriceSeries(numCandles: number, startPrice: number): Candle[] {
    const mu = 0.0002;      // Small positive drift
    const sigma = 0.015;     // Volatility (~1.5% per candle)
    const candles: Candle[] = [];
    let price = startPrice;

    for (let i = 0; i < numCandles; i++) {
        const open = price;
        // Generate intra-candle movement
        const z1 = boxMullerRandom();
        const z2 = boxMullerRandom();
        const z3 = boxMullerRandom();

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

// ─── Technical Indicators ────────────────────────────────────────────────────

function computeRSI(candles: Candle[], period: number, endIdx: number): number {
    if (endIdx < period) return 50; // Neutral

    let gains = 0, losses = 0;
    for (let i = endIdx - period + 1; i <= endIdx; i++) {
        const change = candles[i].close - candles[i - 1].close;
        if (change > 0) gains += change;
        else losses -= change;
    }

    if (losses === 0) return 100;
    const rs = (gains / period) / (losses / period);
    return 100 - 100 / (1 + rs);
}

function computeSMA(candles: Candle[], period: number, endIdx: number): number {
    if (endIdx < period - 1) return candles[endIdx].close;
    let sum = 0;
    for (let i = endIdx - period + 1; i <= endIdx; i++) {
        sum += candles[i].close;
    }
    return sum / period;
}

function computeATR(candles: Candle[], period: number, endIdx: number): number {
    if (endIdx < 1) return 0;

    const start = Math.max(1, endIdx - period + 1);
    let sum = 0;
    let count = 0;

    for (let i = start; i <= endIdx; i++) {
        const tr = Math.max(
            candles[i].high - candles[i].low,
            Math.abs(candles[i].high - candles[i - 1].close),
            Math.abs(candles[i].low - candles[i - 1].close),
        );
        sum += tr;
        count++;
    }

    return count > 0 ? sum / count : 0;
}

// ─── Hook Interface ──────────────────────────────────────────────────────────

interface UseTraderGameLoopProps {
    computeTrader: (inputs: Float32Array) => Float32Array | null;
    evolve: (
        fitnessScores: number[],
        mutationRate: number,
        mutationScale: number,
        strategy: wasm.MutationStrategy,
    ) => void;
    setStats: React.Dispatch<React.SetStateAction<TraderStats>>;
    mutationRate: number;
    mutationScale: number;
    mutationStrategy: wasm.MutationStrategy;
    onGenerationEnd: (maxFitness: number, avgFitness: number) => void;
}

export function useTraderGameLoop({
    computeTrader,
    evolve,
    setStats,
    mutationRate,
    mutationScale,
    mutationStrategy,
    onGenerationEnd,
}: UseTraderGameLoopProps) {
    const gameState = useRef<TraderGameState>({
        agents: [],
        env: {
            candles: [],
            currentPrice: 100,
            rsi: 50,
            smaCrossover: 0,
            atr: 0,
            tick: 0,
        },
        bestTrades: [],
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

    const resetTrader = useCallback(() => {
        const state = gameState.current;

        // Generate fresh price series
        const startPrice = 80 + Math.random() * 40; // $80 - $120
        const candles = generatePriceSeries(TRADER_MAX_FRAMES, startPrice);

        state.agents = Array.from({ length: TRADER_POPULATION_SIZE }, (_, i) => ({
            id: i,
            capital: TRADER_INITIAL_CAPITAL,
            position: 0 as const,
            entryPrice: 0,
            peakCapital: TRADER_INITIAL_CAPITAL,
            maxDrawdown: 0,
            tradeCount: 0,
            fitness: 0,
            dead: false,
            color: `hsl(${(i / TRADER_POPULATION_SIZE) * 60 + 200}, 70%, 55%)`, // Blue-purple palette
            popId: 'traders',
        }));

        state.env = {
            candles,
            currentPrice: candles[0].close,
            rsi: 50,
            smaCrossover: 0,
            atr: 0,
            tick: 0,
        };

        state.bestTrades = [];
        state.frame = 0;
        setStats(s => ({ ...s, alive: TRADER_POPULATION_SIZE }));
    }, [setStats]);

    const runEvolution = useCallback(() => {
        const state = gameState.current;

        // Close all open positions at final price
        const finalPrice = state.env.currentPrice;
        for (const agent of state.agents) {
            if (agent.position !== 0 && !agent.dead) {
                const pnl = agent.position === 1
                    ? (finalPrice - agent.entryPrice) / agent.entryPrice
                    : (agent.entryPrice - finalPrice) / agent.entryPrice;
                agent.capital *= (1 + pnl);
                agent.capital *= (1 - TRADER_FEE_RATE); // Exit fee
                agent.position = 0;
            }
        }

        // Compute fitness: ROI * (1 - maxDrawdown)
        const scores = state.agents.map(a => {
            const roi = a.capital / TRADER_INITIAL_CAPITAL;
            const ddPenalty = 1 - a.maxDrawdown;
            a.fitness = Math.max(0, roi * ddPenalty);
            return a.fitness;
        });

        if (scores.length === 0) return;

        const maxFitness = Math.max(...scores);
        const avgFitness = scores.reduce((a, b) => a + b, 0) / scores.length;

        // Record best agent trades for next gen rendering
        const bestIdx = scores.indexOf(maxFitness);
        const bestAgent = state.agents[bestIdx];

        try {
            evolve(scores, mutationRateRef.current, mutationScaleRef.current, mutationStrategyRef.current);
            state.generation++;

            const avgROI = state.agents.reduce((s, a) => s + a.capital / TRADER_INITIAL_CAPITAL, 0) / state.agents.length;

            setStats({
                generation: state.generation,
                bestROI: bestAgent.capital / TRADER_INITIAL_CAPITAL,
                avgROI,
                bestDrawdown: bestAgent.maxDrawdown,
                alive: state.agents.filter(a => !a.dead).length,
            });
            onGenerationEnd(maxFitness, avgFitness);
            resetTrader();
        } catch (e) {
            console.error('TRADER: evolution error:', e);
        }
    }, [evolve, setStats, onGenerationEnd, resetTrader]);

    const updatePhysics = useCallback(() => {
        if (isComputing.current) return;
        isComputing.current = true;

        try {
            const state = gameState.current;
            const { agents, env } = state;

            // Advance tick
            state.frame++;
            env.tick = state.frame;

            if (env.tick >= TRADER_MAX_FRAMES) {
                runEvolution();
                return;
            }

            const candle = env.candles[env.tick];
            if (!candle) return;

            env.currentPrice = candle.close;

            // Compute indicators
            env.rsi = computeRSI(env.candles, 7, env.tick);
            const sma7 = computeSMA(env.candles, 7, env.tick);
            const sma25 = computeSMA(env.candles, 25, env.tick);
            env.smaCrossover = (sma7 - sma25) / env.currentPrice;
            env.atr = computeATR(env.candles, 7, env.tick);

            // Previous price for log return
            const prevPrice = env.tick > 0 ? env.candles[env.tick - 1].close : candle.open;
            const logReturn = Math.log(candle.close / prevPrice);

            // ── Prepare neural inputs ──
            const inputs = new Float32Array(TRADER_POPULATION_SIZE * TRADER_INPUTS);

            for (let i = 0; i < TRADER_POPULATION_SIZE; i++) {
                const agent = agents[i];
                const base = i * TRADER_INPUTS;

                // Open P&L
                let openPnL = 0;
                if (agent.position !== 0) {
                    openPnL = agent.position === 1
                        ? (env.currentPrice - agent.entryPrice) / agent.entryPrice
                        : (agent.entryPrice - env.currentPrice) / agent.entryPrice;
                }

                // Current drawdown
                const currentDD = agent.peakCapital > 0
                    ? (agent.peakCapital - agent.capital) / agent.peakCapital
                    : 0;

                inputs[base + 0] = logReturn * 100;                       // Amplified log return
                inputs[base + 1] = (env.rsi - 50) / 50;                   // RSI normalized to [-1, 1]
                inputs[base + 2] = env.smaCrossover * 100;                 // SMA crossover amplified
                inputs[base + 3] = env.atr / env.currentPrice * 100;       // Normalized ATR
                inputs[base + 4] = agent.position;                         // -1, 0, or 1
                inputs[base + 5] = Math.tanh(openPnL * 10);               // Clamped open P&L
                inputs[base + 6] = currentDD;                              // Drawdown [0..1]
            }

            // ── Forward pass ──
            const outputs = computeTrader(inputs);
            if (!outputs) return;

            // ── Execute trades ──
            let alive = 0;

            for (let i = 0; i < TRADER_POPULATION_SIZE; i++) {
                const agent = agents[i];
                if (agent.dead) continue;

                const base = i * TRADER_OUTPUTS;
                const buySignal = outputs[base + 0];
                const sellSignal = outputs[base + 1];
                const holdSignal = outputs[base + 2];

                let action: 'buy' | 'sell' | 'hold';
                if (buySignal >= sellSignal && buySignal >= holdSignal) {
                    action = 'buy';
                } else if (sellSignal >= buySignal && sellSignal >= holdSignal) {
                    action = 'sell';
                } else {
                    action = 'hold';
                }

                // Execute action
                if (action === 'buy' && agent.position !== 1) {
                    // Close short if exists
                    if (agent.position === -1) {
                        const pnl = (agent.entryPrice - env.currentPrice) / agent.entryPrice;
                        agent.capital *= (1 + pnl);
                        agent.capital *= (1 - TRADER_FEE_RATE);
                    }
                    // Enter long
                    agent.position = 1;
                    agent.entryPrice = env.currentPrice;
                    agent.capital *= (1 - TRADER_FEE_RATE); // Entry fee
                    agent.tradeCount++;

                    // Track best agent trades
                    if (i === 0) {
                        state.bestTrades.push({ tick: env.tick, action: 'buy', price: env.currentPrice });
                    }
                } else if (action === 'sell' && agent.position !== -1) {
                    // Close long if exists
                    if (agent.position === 1) {
                        const pnl = (env.currentPrice - agent.entryPrice) / agent.entryPrice;
                        agent.capital *= (1 + pnl);
                        agent.capital *= (1 - TRADER_FEE_RATE);
                    }
                    // Enter short
                    agent.position = -1;
                    agent.entryPrice = env.currentPrice;
                    agent.capital *= (1 - TRADER_FEE_RATE);
                    agent.tradeCount++;

                    if (i === 0) {
                        state.bestTrades.push({ tick: env.tick, action: 'sell', price: env.currentPrice });
                    }
                }
                // hold → no action

                // Update peak capital & drawdown
                if (agent.capital > agent.peakCapital) {
                    agent.peakCapital = agent.capital;
                }
                const dd = (agent.peakCapital - agent.capital) / agent.peakCapital;
                if (dd > agent.maxDrawdown) {
                    agent.maxDrawdown = dd;
                }

                // Kill bankrupt agents (< 10% of initial)
                if (agent.capital < TRADER_INITIAL_CAPITAL * 0.1) {
                    agent.dead = true;
                    agent.fitness = 0;
                }

                if (!agent.dead) alive++;
            }

            setStats(s => ({ ...s, alive }));

        } finally {
            isComputing.current = false;
        }
    }, [computeTrader, runEvolution, setStats]);

    return { gameState, resetTrader, updatePhysics };
}
