/**
 * Flappy Configuration - Flappy Bird RL Demo
 *
 * Configuration for the classic reinforcement learning environment.
 */

import { MutationStrategy } from '../wasm/pkg/gran_prix_wasm';

/**
 * Evolution hyperparameters for flappy bird control
 */
export const FLAPPY_EVOLUTION_CONFIG = {
    /** Mutation rate */
    mutationRate: 0.15,

    /** Mutation magnitude */
    mutationScale: 0.5,

    /** Additive mutation strategy */
    mutationStrategy: MutationStrategy.Additive,

    /** Elite birds to preserve */
    eliteCount: 5,
} as const;

/**
 * Game physics parameters
 */
export const FLAPPY_PHYSICS_CONFIG = {
    /** Gravity (downward acceleration) */
    gravity: 0.6,

    /** Jump force (upward velocity) */
    jumpForce: -8.5,

    /** Terminal velocity (max fall speed) */
    terminalVelocity: 12,

    /** Velocity damping */
    damping: 0.99,
} as const;

/**
 * Pipe generation parameters
 */
export const FLAPPY_PIPE_CONFIG = {
    /** Horizontal speed of pipes */
    pipeSpeed: 3,

    /** Distance between pipes */
    pipeSpacing: 250,

    /** Minimum gap top position */
    minGapTop: 100,

    /** Maximum gap top position */
    maxGapTop: 250,
} as const;

/**
 * Fitness function weights
 */
export const FLAPPY_FITNESS_CONFIG = {
    /** Points per frame survived */
    survivalReward: 0.1,

    /** Bonus for passing through a pipe */
    pipePassBonus: 10.0,

    /** Penalty for collision */
    collisionPenalty: 0,

    /** Bonus for staying centered in gap */
    centeringBonus: 0.05,
} as const;
