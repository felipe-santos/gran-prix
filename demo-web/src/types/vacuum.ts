/**
 * Smart Vacuum Cleaner Demo Types
 *
 * Autonomous navigation simulation where agents learn to:
 * - Clean dust efficiently
 * - Avoid obstacles (furniture)
 * - Manage battery by returning to charging station
 */

import { BaseAgent } from './common';

/**
 * Vacuum robot agent with navigation and battery management
 */
export interface VacuumAgent extends BaseAgent {
    /** X position in room (px) */
    x: number;
    /** Y position in room (px) */
    y: number;
    /** Heading angle (radians, 0 = right, π/2 = down) */
    heading: number;
    /** Battery level [0..1] */
    battery: number;
    /** Number of dust cells cleaned */
    dustCleaned: number;
    /** Number of wall/obstacle collisions */
    wallHits: number;
}

/**
 * Furniture obstacle in the room
 */
export interface VacuumObstacle {
    /** Top-left x */
    x: number;
    /** Top-left y */
    y: number;
    /** Width */
    w: number;
    /** Height */
    h: number;
    /** Furniture label for rendering */
    label: string;
}

/**
 * Environment state for vacuum simulation
 */
export interface VacuumEnvState {
    /** 2D dust map (flat array, true = dirty) */
    dustMap: boolean[];
    /** Total initial dust cell count */
    totalDust: number;
    /** Room obstacles (furniture) */
    obstacles: VacuumObstacle[];
    /** Charger station X position */
    chargerX: number;
    /** Charger station Y position */
    chargerY: number;
    /** Grid cell size (px per dust cell) */
    cellSize: number;
    /** Number of cols in dust grid */
    cols: number;
    /** Number of rows in dust grid */
    rows: number;
}

/**
 * Complete game state for vacuum demo
 */
export interface VacuumGameState {
    agents: VacuumAgent[];
    env: VacuumEnvState;
    frame: number;
    generation: number;
}

/**
 * Statistics for vacuum demo
 */
export interface VacuumStats {
    generation: number;
    best: number;
    avgCleaned: number;
    alive: number;
}

// ─── Canvas Configuration ───────────────────────────────────────────────────

export const VACUUM_WIDTH = 800;
export const VACUUM_HEIGHT = 600;
export const VACUUM_SIZE = 12;
export const VACUUM_POPULATION_SIZE = 200;

// ─── Neural Network Topology ────────────────────────────────────────────────

/**
 * Neural network inputs (9):
 *   [0] dustAhead       — dust density in front (normalized)
 *   [1] dustLeft         — dust density to the left (normalized)
 *   [2] dustRight        — dust density to the right (normalized)
 *   [3] obstacleAhead    — distance to nearest obstacle ahead (1=far, 0=hit)
 *   [4] battery          — current battery level [0..1]
 *   [5] distToCharger    — distance to charging station (normalized)
 *   [6] angleToCharger   — angle to charger relative to heading [-1..1]
 *   [7] sinHeading       — sin(heading) cyclic encoding
 *   [8] cosHeading       — cos(heading) cyclic encoding
 */
export const VACUUM_INPUTS = 9;
export const VACUUM_HIDDEN = [10, 8];

/**
 * Neural network outputs (3):
 *   [0] forward   — move forward intensity [0..1]
 *   [1] turnLeft  — turn left intensity [0..1]
 *   [2] turnRight — turn right intensity [0..1]
 */
export const VACUUM_OUTPUTS = 3;

// ─── Simulation Parameters ──────────────────────────────────────────────────

/** Maximum frames per generation (longer allows complex navigation strategies) */
export const VACUUM_MAX_FRAMES = 1400;

/** Dust cell size in pixels */
export const VACUUM_CELL_SIZE = 20;

/** Battery drain per movement step */
export const VACUUM_MOVE_COST = 0.0008;

/** Battery drain per cleaning action */
export const VACUUM_CLEAN_COST = 0.0004;

/** Charger recharge rate per frame (when on charger) */
export const VACUUM_CHARGE_RATE = 0.01;
