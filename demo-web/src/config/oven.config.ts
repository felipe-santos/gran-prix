/**
 * Oven Configuration - Smart Oven IoT Edge AI Demo
 *
 * Configuration for thermodynamic cooking simulation where agents
 * learn to cook different foods without burning.
 */

import { MutationStrategy } from '../wasm/pkg/gran_prix_wasm';

/**
 * Evolution hyperparameters for cooking control
 */
export const OVEN_EVOLUTION_CONFIG = {
    /** Mutation rate for oven control strategies */
    mutationRate: 0.15,

    /** Mutation magnitude */
    mutationScale: 0.5,

    /** Additive mutation for fine temperature control */
    mutationStrategy: MutationStrategy.Additive,

    /** Elite chefs to preserve */
    eliteCount: 5,
} as const;

/**
 * Thermodynamic simulation parameters
 */
export const OVEN_PHYSICS_CONFIG = {
    /** Ambient room temperature (°C) */
    ambientTemp: 25.0,

    /** Maximum oven temperature (°C) */
    maxTemp: 300.0,

    /** Heat transfer rate from air to surface */
    airToSurfaceRate: 0.05,

    /** Heat loss to environment */
    heatLossRate: 0.02,

    /** Convection fan effectiveness multiplier */
    fanEffectiveness: 1.5,
} as const;

/**
 * Cooking success criteria
 */
export const OVEN_SUCCESS_CONFIG = {
    /** Temperature tolerance for "cooked" (±°C) */
    targetTolerance: 5.0,

    /** Minimum time at target temp (frames) */
    minCookTime: 100,

    /** Burn threshold offset from burn temp (°C) */
    burnThreshold: -5.0,

    /** Minimum moisture to not be "dried out" */
    minMoisture: 0.3,
} as const;

/**
 * Fitness function weights
 */
export const OVEN_FITNESS_CONFIG = {
    /** Reward for reaching target core temp */
    cookingReward: 10.0,

    /** Penalty for burning */
    burnPenalty: 15.0,

    /** Penalty for undercooking */
    undercookPenalty: 5.0,

    /** Reward for energy efficiency */
    energyEfficiencyBonus: 2.0,

    /** Penalty for moisture loss */
    moisturePenalty: 3.0,

    /** Bonus for perfect cook (temp + moisture) */
    perfectCookBonus: 5.0,
} as const;

/**
 * Food rotation parameters
 */
export const OVEN_FOOD_CONFIG = {
    /** Probability of changing food type each generation */
    changeProbability: 0.3,

    /** Food types to rotate through */
    rotationEnabled: true,

    /** Food type rotation order (if not random) */
    rotationOrder: ['Cake', 'Pizza', 'Bread', 'Turkey'] as const,
} as const;
