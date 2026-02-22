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
    x: number;
    y: number;
    vy: number;
    color: string;
}

export interface FlappyPipe {
    x: number;
    width: number;
    topHeight: number;
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

export const FLAPPY_INPUTS = 5;
export const FLAPPY_OUTPUTS = 1;
export const FLAPPY_HIDDEN = [8];
export const FLAPPY_POPULATION_SIZE = 200;
