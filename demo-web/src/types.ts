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
/** Number of WASM inputs per bird: [dy_top, dy_bottom, bird_y_norm, vy_norm, unused_dummy] */
export const FLAPPY_INPUTS = 5;
export const FLAPPY_POPULATION_SIZE = 200;

