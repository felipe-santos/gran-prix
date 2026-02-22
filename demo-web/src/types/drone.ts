/**
 * Drone Stabilizer Demo Types
 *
 * Demonstrates continuous control in noisy environments.
 * Neural networks compete against classical PID control to hover at a target point.
 */

import { BaseAgent } from './common';

/**
 * Neural network controlled drone agent
 */
export interface DroneAgent extends BaseAgent {
    x: number;
    y: number;
    vx: number;
    vy: number;
    color: string;
}

/**
 * Classical PID controller drone for comparison
 */
export interface PidDroneAgent {
    x: number;
    y: number;
    vx: number;
    vy: number;
    integralX: number;
    integralY: number;
    prevErrorX: number;
    prevErrorY: number;
    color: string;
}

/**
 * Game state for drone stabilization demo
 */
export interface DroneGameState {
    drones: DroneAgent[];
    pidDrone: PidDroneAgent;
    targetX: number;
    targetY: number;
    windX: number;
    windY: number;
    frame: number;
    generation: number;
}

/**
 * Statistics for drone demo
 */
export interface DroneStats {
    generation: number;
    alive: number;
    best: number;
    avgFitness: number;
}

// ─── Canvas Configuration ───────────────────────────────────────────────────

export const DRONE_WIDTH = 800;
export const DRONE_HEIGHT = 600;
export const DRONE_SIZE = 20;
export const TARGET_RADIUS = 30;
export const DRONE_POPULATION_SIZE = 200;

// ─── Neural Network Topology ────────────────────────────────────────────────

/**
 * Neural network inputs (4):
 *   [0] distBoxX      — distance to target X (normalized)
 *   [1] distBoxY      — distance to target Y (normalized)
 *   [2] vx            — velocity X (normalized)
 *   [3] vy            — velocity Y (normalized)
 */
export const DRONE_INPUTS = 4;
export const DRONE_HIDDEN = [12, 8];

/**
 * Neural network outputs (2):
 *   [0] thrustX       — mapped to [-1, 1] force X
 *   [1] thrustY       — mapped to [-1, 1] force Y (opposes gravity)
 */
export const DRONE_OUTPUTS = 2;

export const DRONE_MAX_FRAMES = 1000;
