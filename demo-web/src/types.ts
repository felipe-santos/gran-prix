export interface Car {
    id: number;
    x: number;
    y: number;
    dead: boolean;
    fitness: number;
    color: string;
}

export interface Obstacle {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface GameState {
    cars: Car[];
    obstacles: Obstacle[];
    score: number;
    generation: number;
    speed: number;
}

export interface GameStats {
    score: number;
    generation: number;
    best: number;
    alive: number;
}

export const GAME_WIDTH = 800;
export const GAME_HEIGHT = 400;
export const PLAYER_SIZE = 20;
export const POPULATION_SIZE = 500;

// ─── Flappy Bird Demo ───────────────────────────────────────────────────────

export interface FlappyBird {
    id: number;
    /** Vertical centre of the bird (0 = top of canvas) */
    y: number;
    /** Vertical velocity (positive = falling) */
    vy: number;
    dead: boolean;
    fitness: number;
    color: string;
}

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

export interface FlappyGameState {
    birds: FlappyBird[];
    pipes: FlappyPipe[];
    score: number;
    generation: number;
    speed: number;
}

export interface FlappyStats {
    score: number;
    generation: number;
    best: number;
    alive: number;
}

// Canvas dimensions (intentionally same as Cars so canvas sizes are consistent)
export const FLAPPY_WIDTH = 800;
export const FLAPPY_HEIGHT = 400;
export const FLAPPY_BIRD_SIZE = 18;
export const FLAPPY_PIPE_WIDTH = 60;
/** Vertical gap between top and bottom pipes */
export const FLAPPY_GAP_SIZE = 130;
/** Number of WASM inputs per bird: [dy_top, dy_bottom, bird_y_norm, vy_norm] */
export const FLAPPY_INPUTS = 4;
export const FLAPPY_POPULATION_SIZE = 200;

// ─── Bipedal Walker Demo ────────────────────────────────────────────────────

export interface WalkerAgent {
    id: number;
    /** Horizontal distance traveled from spawn (metres, planck scale) */
    distance: number;
    dead: boolean;
    fitness: number;
    color: string;
}

export interface WalkerGameState {
    agents: WalkerAgent[];
    /** Frame counter within current generation */
    frame: number;
    generation: number;
}

export interface WalkerStats {
    generation: number;
    alive: number;
    best: number;
    avgDistance: number;
}

// Canvas dimensions — taller than Flappy/Cars to show walking action vertically
export const WALKER_WIDTH = 800;
export const WALKER_HEIGHT = 500;

/** Number of simultaneous learning agents */
export const WALKER_POPULATION_SIZE = 50;

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
