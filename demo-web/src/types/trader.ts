/**
 * AI Trader Evolution Demo Types
 *
 * Financial trading simulation where agents learn to maximize
 * portfolio value by analyzing technical indicators and managing risk.
 */

import { BaseAgent } from './common';

/**
 * Trader agent managing a portfolio
 */
export interface TraderAgent extends BaseAgent {
    /** Current capital ($) */
    capital: number;
    /** Position: -1 short, 0 cash, 1 long */
    position: -1 | 0 | 1;
    /** Price at which current position was entered */
    entryPrice: number;
    /** Peak capital reached (for drawdown tracking) */
    peakCapital: number;
    /** Maximum drawdown encountered [0..1] */
    maxDrawdown: number;
    /** Number of trades executed */
    tradeCount: number;
}

/**
 * OHLC candlestick data
 */
export interface Candle {
    open: number;
    high: number;
    low: number;
    close: number;
}

/**
 * Trading environment state (market data + indicators)
 */
export interface TraderEnvState {
    /** Full price history (candles) */
    candles: Candle[];
    /** Current asset price */
    currentPrice: number;
    /** RSI(7) [0..100] */
    rsi: number;
    /** SMA(7) - SMA(25) normalized */
    smaCrossover: number;
    /** Average True Range (7) normalized */
    atr: number;
    /** Current tick/candle index */
    tick: number;
}

/**
 * Game state for trader demo
 */
export interface TraderGameState {
    agents: TraderAgent[];
    env: TraderEnvState;
    /** Best agent's trade history for rendering markers */
    bestTrades: { tick: number; action: 'buy' | 'sell'; price: number }[];
    frame: number;
    generation: number;
}

/**
 * Statistics for trader demo
 */
export interface TraderStats {
    generation: number;
    bestROI: number;
    avgROI: number;
    bestDrawdown: number;
    alive: number;
}

// ─── Canvas Configuration ───────────────────────────────────────────────────

export const TRADER_WIDTH = 900;
export const TRADER_HEIGHT = 600;
export const TRADER_POPULATION_SIZE = 200;

// ─── Neural Network Topology ────────────────────────────────────────────────

/**
 * Neural network inputs (7):
 *   [0] logReturn      — log(price / prevPrice) normalized
 *   [1] rsi            — RSI(7) normalized to [-1, 1]
 *   [2] smaCrossover   — (SMA7 - SMA25) / price, normalized
 *   [3] atr            — ATR(7) / price, normalized volatility
 *   [4] positionState  — current position (-1, 0, 1)
 *   [5] openPnL        — unrealized profit/loss (normalized)
 *   [6] drawdown       — current drawdown from peak [0..1]
 */
export const TRADER_INPUTS = 7;
export const TRADER_HIDDEN = 10;

/**
 * Neural network outputs (3):
 *   [0] buy   — enter or hold long position
 *   [1] sell  — exit position or enter short
 *   [2] hold  — do nothing
 */
export const TRADER_OUTPUTS = 3;

// ─── Simulation Parameters ──────────────────────────────────────────────────

/** Number of candles per generation */
export const TRADER_MAX_FRAMES = 500;

/** Starting capital for each agent */
export const TRADER_INITIAL_CAPITAL = 10000;

/** Fee rate per trade (0.1%) */
export const TRADER_FEE_RATE = 0.001;
