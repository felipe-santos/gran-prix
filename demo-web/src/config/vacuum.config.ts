/**
 * Vacuum Configuration - Smart Vacuum Cleaner Demo
 *
 * Centralized configuration for vacuum simulation parameters.
 */

import { MutationStrategy } from '../wasm/pkg/gran_prix_wasm';

/**
 * Evolution hyperparameters optimized for vacuum navigation
 */
export const VACUUM_EVOLUTION_CONFIG = {
    /** Probability of weight mutation (0-1) */
    mutationRate: 0.15,

    /** Magnitude of weight changes */
    mutationScale: 0.5,

    /** Default mutation strategy - Additive works best for local refinement */
    mutationStrategy: MutationStrategy.Additive,

    /** Number of elite agents to preserve (top performers) */
    eliteCount: 3,
} as const;

/**
 * Simulation physics and environment parameters
 */
export const VACUUM_SIMULATION_CONFIG = {
    /** Speed multiplier for physics updates per frame */
    physicsSpeed: 4,

    /** Initial dust coverage percentage */
    initialDustCoverage: 0.55,

    /** Number of high-density dust clusters */
    dustClusters: 3,

    /** Dust cluster radius (in cells) */
    clusterRadius: 2,

    /** Number of furniture obstacles */
    furnitureCount: 5,
} as const;

/**
 * Rendering and visualization settings
 */
export const VACUUM_RENDER_CONFIG = {
    /** Number of top agents to render with full opacity */
    topAgentsVisible: 10,

    /** Show sensor rays on best agent */
    showSensors: true,

    /** Show mini dust map */
    showMiniMap: true,

    /** Mini-map position and size */
    miniMap: {
        x: 620, // VACUUM_WIDTH - 180
        y: 60,
        width: 170,
        height: 120,
    },
} as const;

/**
 * Fitness function weights
 */
export const VACUUM_FITNESS_CONFIG = {
    /** Points per fair share of dust cleaned */
    cleaningReward: 10.0,

    /** Bonus for returning to charger with battery > 10% */
    batteryBonus: 2.0,

    /** Penalty per wall collision */
    wallPenalty: 0.02,

    /** Max wall penalty cap */
    maxWallPenalty: 2.0,

    /** Penalty for dying (battery empty away from charger) */
    deathPenalty: 3.0,
} as const;
