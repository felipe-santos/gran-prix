/**
 * Walker Configuration - Bipedal Walker Demo
 *
 * Configuration for learning to walk with motor coordination.
 */

import { MutationStrategy } from '../wasm/pkg/gran_prix_wasm';

/**
 * Evolution hyperparameters for bipedal locomotion
 */
export const WALKER_EVOLUTION_CONFIG = {
    /** Higher mutation rate for motor exploration */
    mutationRate: 0.2,

    /** Magnitude of weight changes */
    mutationScale: 0.5,

    /** Additive mutation strategy */
    mutationStrategy: MutationStrategy.Additive,

    /** Elite walkers to preserve */
    eliteCount: 3,
} as const;

/**
 * Physics simulation parameters (Planck.js)
 */
export const WALKER_PHYSICS_CONFIG = {
    /** Gravity (m/s²) */
    gravity: -9.8,

    /** Ground friction */
    groundFriction: 0.3,

    /** Joint friction */
    jointFriction: 0.1,

    /** Motor max force (torque) */
    motorMaxForce: 100,

    /** Motor speed scaling */
    motorSpeed: 5.0,
} as const;

/**
 * Body structure parameters
 */
export const WALKER_BODY_CONFIG = {
    /** Torso dimensions (width, height) */
    torso: { width: 0.5, height: 1.0 },

    /** Upper leg length */
    upperLeg: 0.6,

    /** Lower leg length */
    lowerLeg: 0.5,

    /** Body density */
    density: 1.0,
} as const;

/**
 * Fitness function weights
 */
export const WALKER_FITNESS_CONFIG = {
    /** Reward per meter traveled */
    distanceReward: 10.0,

    /** Penalty for falling (torso angle > threshold) */
    fallPenalty: 5.0,

    /** Fall angle threshold (radians) */
    fallThreshold: Math.PI / 3,

    /** Bonus for staying upright */
    uprightBonus: 1.0,

    /** Penalty for excessive energy use */
    energyPenalty: 0.01,
} as const;
