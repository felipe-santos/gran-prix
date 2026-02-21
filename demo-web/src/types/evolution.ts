/**
 * Types for the original Genetic Evolution (Car Avoidance) Demo
 *
 * This is the foundational demo showing basic NEAT-style evolution
 * with cars avoiding obstacles.
 */

import { BaseAgent, GameStats, Obstacle } from './common';

/**
 * Car agent in the evolution demo
 */
export interface Car extends BaseAgent {
    x: number;
    y: number;
}

/**
 * Game state for car evolution demo
 */
export interface GameState {
    cars: Car[];
    obstacles: Obstacle[];
    score: number;
    generation: number;
    speed: number;
}

// ─── Canvas Configuration ───────────────────────────────────────────────────

export const GAME_WIDTH = 800;
export const GAME_HEIGHT = 400;
export const PLAYER_SIZE = 20;
export const POPULATION_SIZE = 500;
