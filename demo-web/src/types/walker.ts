/**
 * Bipedal Walker Demo Types
 *
 * Motor coordination simulation where agents learn to walk
 * by controlling 4 joint motors (2 hips, 2 knees).
 */

import { BaseAgent } from './common';

/**
 * Bipedal walker agent
 */
export interface WalkerAgent extends BaseAgent {
    /** Horizontal distance traveled from spawn (metres, planck scale) */
    distance: number;
}

/**
 * Game state for walker demo
 */
export interface WalkerGameState {
    agents: WalkerAgent[];
    /** Frame counter within current generation */
    frame: number;
    generation: number;
}

/**
 * Statistics for walker demo
 */
export interface WalkerStats {
    generation: number;
    alive: number;
    best: number;
    avgDistance: number;
}

// ─── Canvas Configuration ───────────────────────────────────────────────────

export const WALKER_WIDTH = 800;
export const WALKER_HEIGHT = 500;
export const WALKER_POPULATION_SIZE = 50;

// ─── Neural Network Topology ────────────────────────────────────────────────

/**
 * Neural network inputs (10):
 *   [0] body_angle         — torso tilt (radians, normalized)
 *   [1] body_angular_vel   — torso angular velocity
 *   [2] left_hip_angle     — left hip joint angle
 *   [3] left_hip_vel       — left hip angular velocity
 *   [4] left_knee_angle    — left knee joint angle
 *   [5] left_knee_vel      — left knee angular velocity
 *   [6] right_hip_angle    — right hip joint angle
 *   [7] right_hip_vel      — right hip angular velocity
 *   [8] right_knee_angle   — right knee joint angle
 *   [9] right_knee_vel     — right knee angular velocity
 */
export const WALKER_INPUTS = 10;

/** Hidden layer size — larger than Flappy because motor coordination is harder */
export const WALKER_HIDDEN = 12;

/**
 * Neural network outputs (4 continuous):
 *   [0] left_hip_torque    — mapped to [-1, 1] motor speed
 *   [1] left_knee_torque   — mapped to [-1, 1] motor speed
 *   [2] right_hip_torque   — mapped to [-1, 1] motor speed
 *   [3] right_knee_torque  — mapped to [-1, 1] motor speed
 */
export const WALKER_OUTPUTS = 4;

/** Maximum frames per generation before forced evolution */
export const WALKER_MAX_FRAMES = 600;
