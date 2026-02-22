/**
 * Common types shared across all demos
 *
 * This module contains base interfaces and types used by multiple
 * game simulations and demonstrations.
 */

/**
 * Generic game statistics interface
 * Used by most demos to track generation progress
 */
export interface GameStats {
    score: number;
    generation: number;
    best: number;
    alive: number;
}

/**
 * Performance tracking data point
 * Used for charts and metrics visualization
 */
export interface PerformanceData {
    generation: number;
    avg: number;
    max: number;
}

/**
 * Generic obstacle/barrier interface
 * Used by Car Evolution, Vacuum, and other spatial demos
 */
export interface Obstacle {
    x: number;
    y: number;
    w: number;
    h: number;
}

/**
 * Base agent interface with common properties
 * Extended by specific demo agent types
 */
export interface BaseAgent {
    id: number;
    popId: string; // Added for multi-population support
    fitness: number;
    dead: boolean;
    color: string;
}
