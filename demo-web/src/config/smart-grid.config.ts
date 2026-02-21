/**
 * Smart Grid Configuration - Energy Optimization Demo
 *
 * Configuration for smart home energy management simulation
 * with solar panels, battery storage, and dynamic pricing.
 */

import { MutationStrategy } from '../wasm/pkg/gran_prix_wasm';

/**
 * Evolution hyperparameters for energy management strategies
 */
export const GRID_EVOLUTION_CONFIG = {
    /** Mutation rate */
    mutationRate: 0.15,

    /** Mutation magnitude */
    mutationScale: 0.5,

    /** Additive mutation for strategy refinement */
    mutationStrategy: MutationStrategy.Additive,

    /** Elite energy managers to preserve */
    eliteCount: 5,
} as const;

/**
 * Energy system parameters
 */
export const GRID_ENERGY_CONFIG = {
    /** Base house consumption (kW) */
    baseConsumption: 1.5,

    /** Peak consumption multiplier (morning/evening) */
    peakMultiplier: 2.5,

    /** Peak hours (morning) */
    morningPeak: { start: 6, end: 9 },

    /** Peak hours (evening) */
    eveningPeak: { start: 18, end: 21 },

    /** Solar panel degradation per generation (%) */
    solarDegradation: 0,
} as const;

/**
 * Pricing model
 */
export const GRID_PRICING_CONFIG = {
    /** Base electricity price ($/kWh) */
    basePrice: 0.12,

    /** Peak price multiplier */
    peakPriceMultiplier: 2.0,

    /** Off-peak price multiplier */
    offPeakMultiplier: 0.7,

    /** Solar sell-back rate (% of purchase price) */
    sellBackRate: 0.75,

    /** Price volatility (randomness) */
    priceVolatility: 0.1,
} as const;

/**
 * Weather simulation
 */
export const GRID_WEATHER_CONFIG = {
    /** Average cloud cover */
    avgCloudCover: 0.3,

    /** Cloud cover change rate */
    cloudChangeRate: 0.05,

    /** Seasonal solar variation (%) */
    seasonalVariation: 0.2,
} as const;

/**
 * Fitness function weights
 */
export const GRID_FITNESS_CONFIG = {
    /** Weight for cost minimization */
    costWeight: 1.0,

    /** Penalty for grid dependency */
    gridDependencyPenalty: 0.1,

    /** Reward for self-sufficiency */
    selfSufficiencyBonus: 2.0,

    /** Penalty for battery cycling (wear) */
    batteryCyclePenalty: 0.05,

    /** Bonus for zero blackout */
    reliabilityBonus: 5.0,
} as const;
