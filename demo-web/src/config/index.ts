/**
 * Gran-Prix Configuration System
 *
 * Centralized configuration for all demos to prevent magic numbers
 * and duplicated constants across components.
 *
 * ## Architecture
 * Each demo has its own config module organized by concern:
 * - Evolution: mutation rates, strategies, elitism
 * - Physics: simulation parameters, forces, speeds
 * - Fitness: reward/penalty weights
 * - Rendering: visual settings, colors, etc.
 *
 * ## Usage
 *
 * ```typescript
 * // Import specific demo config
 * import { VACUUM_EVOLUTION_CONFIG } from '@/config/vacuum.config';
 *
 * // Use in component
 * const mutationRate = VACUUM_EVOLUTION_CONFIG.mutationRate;
 * ```
 *
 * ## Benefits
 * - ✅ Single source of truth
 * - ✅ Easy hyperparameter tuning
 * - ✅ Type-safe constants
 * - ✅ Documentation in one place
 * - ✅ Prevents accidental changes
 */

// ─── Evolution (Original Car Demo) ─────────────────────────────────────────
export {
    EVOLUTION_CONFIG,
    EVOLUTION_DISPLAY_CONFIG,
} from './evolution.config';

// ─── Flappy Bird RL ─────────────────────────────────────────────────────────
export {
    FLAPPY_EVOLUTION_CONFIG,
    FLAPPY_PHYSICS_CONFIG,
    FLAPPY_PIPE_CONFIG,
    FLAPPY_FITNESS_CONFIG,
} from './flappy.config';

// ─── Bipedal Walker ─────────────────────────────────────────────────────────
export {
    WALKER_EVOLUTION_CONFIG,
    WALKER_PHYSICS_CONFIG,
    WALKER_BODY_CONFIG,
    WALKER_FITNESS_CONFIG,
} from './walker.config';

// ─── Predator vs Prey ───────────────────────────────────────────────────────
export {
    PREDATOR_EVOLUTION_CONFIG,
    PREY_EVOLUTION_CONFIG,
    PREDATOR_PHYSICS_CONFIG,
    PREY_PHYSICS_CONFIG,
    PREDATOR_FITNESS_CONFIG,
    PREY_FITNESS_CONFIG,
    PREDATOR_PREY_ENV_CONFIG,
} from './predator-prey.config';

// ─── Drone Stabilizer ───────────────────────────────────────────────────────
export {
    DRONE_EVOLUTION_CONFIG,
    DRONE_SIMULATION_CONFIG,
    DRONE_PID_CONFIG,
    DRONE_FITNESS_CONFIG,
} from './drone.config';

// ─── Smart Grid Optimization ────────────────────────────────────────────────
export {
    GRID_EVOLUTION_CONFIG,
    GRID_ENERGY_CONFIG,
    GRID_PRICING_CONFIG,
    GRID_WEATHER_CONFIG,
    GRID_FITNESS_CONFIG,
} from './smart-grid.config';

// ─── AI Trader ──────────────────────────────────────────────────────────────
export {
    TRADER_EVOLUTION_CONFIG,
    TRADER_SIMULATION_CONFIG,
    TRADER_INDICATORS_CONFIG,
    TRADER_RISK_CONFIG,
    TRADER_FITNESS_CONFIG,
} from './trader.config';

// ─── Smart Vacuum Cleaner ───────────────────────────────────────────────────
export {
    VACUUM_EVOLUTION_CONFIG,
    VACUUM_SIMULATION_CONFIG,
    VACUUM_RENDER_CONFIG,
    VACUUM_FITNESS_CONFIG,
} from './vacuum.config';

// ─── Smart Oven (IoT Edge AI) ───────────────────────────────────────────────
export {
    OVEN_EVOLUTION_CONFIG,
    OVEN_PHYSICS_CONFIG,
    OVEN_SUCCESS_CONFIG,
    OVEN_FITNESS_CONFIG,
    OVEN_FOOD_CONFIG,
} from './oven.config';
