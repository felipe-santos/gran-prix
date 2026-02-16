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
