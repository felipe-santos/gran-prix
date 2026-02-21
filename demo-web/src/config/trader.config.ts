/**
 * Trader Configuration - AI Trader Evolution Demo
 *
 * Configuration for financial trading simulation with
 * technical analysis and risk management.
 */

import { MutationStrategy } from '../wasm/pkg/gran_prix_wasm';

/**
 * Evolution hyperparameters for trading strategies
 */
export const TRADER_EVOLUTION_CONFIG = {
    /** Slightly higher mutation for strategy exploration */
    mutationRate: 0.18,

    /** Magnitude of weight changes */
    mutationScale: 0.5,

    /** Additive mutation for strategy refinement */
    mutationStrategy: MutationStrategy.Additive,

    /** Preserve top traders */
    eliteCount: 5,
} as const;

/**
 * Market simulation parameters
 */
export const TRADER_SIMULATION_CONFIG = {
    /** Price volatility (for synthetic data) */
    volatility: 0.02,

    /** Trend strength */
    trendStrength: 0.001,

    /** Mean reversion factor */
    meanReversion: 0.95,

    /** Number of warmup candles (for indicators) */
    warmupPeriod: 50,
} as const;

/**
 * Technical indicators configuration
 */
export const TRADER_INDICATORS_CONFIG = {
    /** RSI period */
    rsiPeriod: 7,

    /** Fast SMA period */
    smaFast: 7,

    /** Slow SMA period */
    smaSlow: 25,

    /** ATR period (volatility) */
    atrPeriod: 7,

    /** RSI overbought threshold */
    rsiOverbought: 70,

    /** RSI oversold threshold */
    rsiOversold: 30,
} as const;

/**
 * Risk management parameters
 */
export const TRADER_RISK_CONFIG = {
    /** Maximum position size (% of capital) */
    maxPositionSize: 1.0,

    /** Stop loss percentage */
    stopLoss: 0.05,

    /** Take profit percentage */
    takeProfit: 0.1,

    /** Max drawdown before forced exit */
    maxDrawdown: 0.3,
} as const;

/**
 * Fitness function weights
 */
export const TRADER_FITNESS_CONFIG = {
    /** Weight for ROI (Return on Investment) */
    roiWeight: 1.0,

    /** Penalty for drawdown */
    drawdownPenalty: 0.5,

    /** Reward for Sharpe ratio (risk-adjusted return) */
    sharpeWeight: 0.3,

    /** Minimum trades to be considered valid strategy */
    minTrades: 5,
} as const;
