/**
 * Gran-Prix Type System - Modular Export Index
 *
 * This file provides centralized access to all type definitions used
 * across the Gran-Prix demo web application.
 *
 * ## Architecture
 * Types are organized by demo/domain to improve:
 * - Tree-shaking (only import what you need)
 * - Maintainability (each demo's types in one place)
 * - Readability (clear module boundaries)
 *
 * ## Usage Examples
 *
 * ```typescript
 * // Import specific demo types
 * import { VacuumAgent, VACUUM_WIDTH } from '@/types/vacuum';
 *
 * // Import common types
 * import { GameStats, PerformanceData } from '@/types/common';
 *
 * // Import from index (legacy compatibility)
 * import { VacuumAgent, DroneAgent } from '@/types';
 * ```
 */

// ─── Common Types ───────────────────────────────────────────────────────────
export type {
    GameStats,
    PerformanceData,
    Obstacle,
    BaseAgent,
    MousePredictionPhase,
    MousePoint,
} from './common';

// ─── Evolution (Original Car Demo) ──────────────────────────────────────────
export type {
    Car,
    GameState,
} from './evolution';
export {
    GAME_WIDTH,
    GAME_HEIGHT,
    PLAYER_SIZE,
    POPULATION_SIZE,
    EVOLUTION_INPUTS,
    EVOLUTION_HIDDEN,
    EVOLUTION_OUTPUTS,
} from './evolution';

// ─── Flappy Bird RL ─────────────────────────────────────────────────────────
export type {
    FlappyBird,
    FlappyPipe,
    FlappyGameState,
    FlappyStats,
} from './flappy';
export {
    FLAPPY_WIDTH,
    FLAPPY_HEIGHT,
    FLAPPY_BIRD_SIZE,
    FLAPPY_PIPE_WIDTH,
    FLAPPY_GAP_SIZE,
    FLAPPY_INPUTS,
    FLAPPY_OUTPUTS,
    FLAPPY_HIDDEN,
    FLAPPY_POPULATION_SIZE,
} from './flappy';

// ─── Bipedal Walker ─────────────────────────────────────────────────────────
export type {
    WalkerAgent,
    WalkerGameState,
    WalkerStats,
} from './walker';
export {
    WALKER_WIDTH,
    WALKER_HEIGHT,
    WALKER_POPULATION_SIZE,
    WALKER_INPUTS,
    WALKER_HIDDEN,
    WALKER_OUTPUTS,
    WALKER_MAX_FRAMES,
} from './walker';

// ─── Predator vs Prey ───────────────────────────────────────────────────────
export type {
    PredatorAgent,
    PreyAgent,
    PredatorPreyGameState,
    PredatorPreyStats,
} from './predator-prey';
export {
    PREDATOR_PREY_WIDTH,
    PREDATOR_PREY_HEIGHT,
    PREDATOR_SIZE,
    PREY_SIZE,
    PREDATOR_POPULATION_SIZE,
    PREY_POPULATION_SIZE,
    PREDATOR_INPUTS,
    PREDATOR_HIDDEN,
    PREDATOR_OUTPUTS,
    PREY_INPUTS,
    PREY_HIDDEN,
    PREY_OUTPUTS,
    PREDATOR_PREY_MAX_FRAMES,
} from './predator-prey';

// ─── Drone Stabilizer ───────────────────────────────────────────────────────
export type {
    DroneAgent,
    PidDroneAgent,
    DroneGameState,
    DroneStats,
} from './drone';
export {
    DRONE_WIDTH,
    DRONE_HEIGHT,
    DRONE_SIZE,
    TARGET_RADIUS,
    DRONE_POPULATION_SIZE,
    DRONE_INPUTS,
    DRONE_HIDDEN,
    DRONE_OUTPUTS,
    DRONE_MAX_FRAMES,
} from './drone';

// ─── Smart Grid Optimization ────────────────────────────────────────────────
export type {
    GridAgent,
    GridEnvState,
    GridGameState,
    GridStats,
} from './smart-grid';
export {
    GRID_WIDTH,
    GRID_HEIGHT,
    GRID_POPULATION_SIZE,
    GRID_INPUTS,
    GRID_HIDDEN,
    GRID_OUTPUTS,
    GRID_MAX_FRAMES,
    GRID_BATTERY_CAPACITY,
    GRID_PEAK_SOLAR,
    GRID_BATTERY_EFFICIENCY,
} from './smart-grid';

// ─── AI Trader ──────────────────────────────────────────────────────────────
export type {
    TraderAgent,
    Candle,
    TraderEnvState,
    TraderGameState,
    TraderStats,
} from './trader';
export {
    TRADER_WIDTH,
    TRADER_HEIGHT,
    TRADER_POPULATION_SIZE,
    TRADER_INPUTS,
    TRADER_HIDDEN,
    TRADER_OUTPUTS,
    TRADER_MAX_FRAMES,
    TRADER_INITIAL_CAPITAL,
    TRADER_FEE_RATE,
} from './trader';

// ─── Smart Vacuum Cleaner ───────────────────────────────────────────────────
export type {
    VacuumAgent,
    VacuumObstacle,
    VacuumEnvState,
    VacuumGameState,
    VacuumStats,
} from './vacuum';
export {
    VACUUM_WIDTH,
    VACUUM_HEIGHT,
    VACUUM_SIZE,
    VACUUM_POPULATION_SIZE,
    VACUUM_INPUTS,
    VACUUM_HIDDEN,
    VACUUM_OUTPUTS,
    VACUUM_MAX_FRAMES,
    VACUUM_CELL_SIZE,
    VACUUM_MOVE_COST,
    VACUUM_CLEAN_COST,
    VACUUM_CHARGE_RATE,
} from './vacuum';

// ─── Smart Oven (IoT Edge AI) ───────────────────────────────────────────────
export type {
    OvenAgent,
    OvenFoodProfile,
    OvenGameState,
    OvenStats,
} from './oven';
export {
    OvenFoodType,
    OVEN_FOODS,
    OVEN_INPUTS,
    OVEN_HIDDEN,
    OVEN_OUTPUTS,
    OVEN_POPULATION_SIZE,
    OVEN_MAX_FRAMES,
    OVEN_AMBIENT_TEMP,
    OVEN_MAX_TEMP,
} from './oven';
