/**
 * Evolution Configuration - Original Car Avoidance Demo
 *
 * Centralized configuration for genetic evolution parameters.
 * This prevents magic numbers scattered throughout components.
 */

import { MutationStrategy } from '../wasm/pkg/gran_prix_wasm';

/**
 * Evolution hyperparameters for the car avoidance demo
 */
export const EVOLUTION_CONFIG = {
    /** Probability of weight mutation (0-1) */
    mutationRate: 0.2,

    /** Magnitude of weight changes */
    mutationScale: 0.5,

    /** Default mutation strategy */
    mutationStrategy: MutationStrategy.Additive,

    /** Elitism: top N agents survive unchanged */
    eliteCount: 5,

    /** Tournament size for selection */
    tournamentSize: 5,
} as const;

/**
 * Display configuration for evolution UI
 */
export const EVOLUTION_DISPLAY_CONFIG = {
    /** Show brain inspector by default */
    showInspector: false,

    /** Show performance charts */
    showCharts: true,

    /** Chart history length (generations) */
    chartHistory: 50,
} as const;
