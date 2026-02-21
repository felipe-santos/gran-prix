/**
 * Predator vs Prey Co-evolution Demo Types
 *
 * Multi-agent simulation where two populations (foxes and rabbits)
 * evolve competing strategies in an arms race.
 */

import { BaseAgent } from './common';

/**
 * Predator agent (Fox)
 */
export interface PredatorAgent extends BaseAgent {
    x: number;
    y: number;
    vx: number;
    vy: number;
    /** Loses energy over time, gains from eating */
    energy: number;
    /** +1 for eating, +0.1 for surviving */
    fitness: number;
}

/**
 * Prey agent (Rabbit)
 */
export interface PreyAgent extends BaseAgent {
    x: number;
    y: number;
    vx: number;
    vy: number;
    /** Loses energy running, regains while resting */
    energy: number;
    /** +1 per frame survived */
    fitness: number;
}

/**
 * Game state for predator-prey demo
 */
export interface PredatorPreyGameState {
    predators: PredatorAgent[];
    prey: PreyAgent[];
    frame: number;
    generation: number;
}

/**
 * Statistics for predator-prey demo
 */
export interface PredatorPreyStats {
    generation: number;
    predatorsAlive: number;
    preyAlive: number;
    predatorBest: number;
    preyBest: number;
}

// ─── Canvas Configuration ───────────────────────────────────────────────────

/** Larger arena to allow flocking and chasing */
export const PREDATOR_PREY_WIDTH = 800;
export const PREDATOR_PREY_HEIGHT = 800;
export const PREDATOR_SIZE = 16;
export const PREY_SIZE = 10;

export const PREDATOR_POPULATION_SIZE = 30;
export const PREY_POPULATION_SIZE = 150;

// ─── Neural Network Topology ────────────────────────────────────────────────

/**
 * Predator Inputs (7):
 * [0] distance to nearest prey (normalized)
 * [1] angle to nearest prey
 * [2] current vx (normalized)
 * [3] current vy (normalized)
 * [4] distance to closest wall (normalized)
 * [5] current energy (normalized)
 * [6] constant bias / random noise
 */
export const PREDATOR_INPUTS = 7;
export const PREDATOR_HIDDEN = 12;

/**
 * Predator Outputs (2):
 * [0] thrust (accelerate)
 * [1] angular acceleration (turn left/right)
 */
export const PREDATOR_OUTPUTS = 2;

/**
 * Prey Inputs (7):
 * [0] distance to nearest predator (normalized)
 * [1] angle to nearest predator
 * [2] current vx (normalized)
 * [3] current vy (normalized)
 * [4] distance to closest wall (normalized)
 * [5] current energy (normalized)
 * [6] distance to nearest flock member (rabbit)
 */
export const PREY_INPUTS = 7;
export const PREY_HIDDEN = 12;

/**
 * Prey Outputs (2):
 * [0] thrust (accelerate)
 * [1] angular acceleration (turn left/right)
 */
export const PREY_OUTPUTS = 2;

/** Maximum frames before forced generation cycle */
export const PREDATOR_PREY_MAX_FRAMES = 1200;
