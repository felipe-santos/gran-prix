/**
 * Flappy Bird Demo Types
 *
 * Classic reinforcement learning environment where birds learn
 * to navigate through pipe gaps by controlling jump timing.
 */

import { BaseAgent } from './common';

/**
 * Flappy bird agent
 */
export interface FlappyBird extends BaseAgent {
    /** Vertical centre of the bird (0 = top of canvas) */
    y: number;
    /** Vertical velocity (positive = falling) */
    vy: number;
}

/**
 * Pipe obstacle with gap
 */
export interface FlappyPipe {
    /** Left edge x-position */
    x: number;
    /** Bottom of the top pipe */
    gapTop: number;
    /** Top of the bottom pipe */
    gapBottom: number;
    /** Whether this pipe has been passed (for bonus scoring) */
    passed: boolean;
}

/**
 * Game state for Flappy Bird demo
 */
export interface FlappyGameState {
    birds: FlappyBird[];
    pipes: FlappyPipe[];
    score: number;
    generation: number;
    speed: number;
}

/**
 * Statistics for Flappy demo
 */
export interface FlappyStats {
    score: number;
    generation: number;
    best: number;
    alive: number;
}

// ─── Canvas Configuration ───────────────────────────────────────────────────

export const FLAPPY_WIDTH = 800;
export const FLAPPY_HEIGHT = 400;
export const FLAPPY_BIRD_SIZE = 18;
export const FLAPPY_PIPE_WIDTH = 60;

/** Vertical gap between top and bottom pipes */
export const FLAPPY_GAP_SIZE = 130;

/** Number of WASM inputs per bird: [dy_top, dy_bottom, bird_y_norm, vy_norm] */
export const FLAPPY_INPUTS = 4;
export const FLAPPY_HIDDEN = [8];
export const FLAPPY_POPULATION_SIZE = 200;
