import { BaseAgent, GameStats } from './common';

// --- Constants ---
export const TURRET_WIDTH = 800;
export const TURRET_HEIGHT = 600;
export const TURRET_POPULATION_SIZE = 150;

// Neural Network config
export const TURRET_INPUTS = 6;  // DroneX, DroneY, DroneVX, Wind, TurretAngle, Cooldown
export const TURRET_HIDDEN = [16, 12];
export const TURRET_OUTPUTS = 2; // MotorSpeed (-1 to 1), Fire (>0.5)

export const TURRET_MAX_FRAMES = 600;

// Physics
export const GRAVITY = 0.2;
export const PROJECTILE_SPEED = 15;
export const DRONE_SPEED_BASE = 3.5;

// --- Interfaces ---
export interface TurretAgent extends BaseAgent {
    angle: number;           // 0 to 180 degrees (in radians, from -PI/2 to PI/2 relative to straight up)
    cooldownTimer: number;   // Frames until can fire again
    projectiles: Projectile[];
    hits: number;
    shotsFired: number;
    trackingScore: number;
}

export interface Projectile {
    x: number;
    y: number;
    vx: number;
    vy: number;
    active: boolean;
}

export interface DroneTarget {
    x: number;
    y: number;
    baseY: number;
    vx: number;
    time: number;
}

export interface TurretGameState {
    generation: number;
    frame: number;
    agents: TurretAgent[];
    drone: DroneTarget;
    windMagnitude: number;
    windDirection: number; // 1 for right, -1 for left
}

export interface TurretStats extends GameStats {
    bestTracking: number;
    totalHits: number;
}
