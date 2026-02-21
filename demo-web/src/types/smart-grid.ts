/**
 * Smart Grid Optimization Demo Types
 *
 * Energy management simulation where agents learn to optimize
 * electricity costs by managing solar panels, battery storage,
 * and grid purchases/sales.
 */

import { BaseAgent } from './common';

/**
 * Smart home grid agent
 */
export interface GridAgent extends BaseAgent {
    /** Battery State of Charge [0..1] */
    batterySoC: number;
    /** Accumulated electricity cost ($) */
    totalCost: number;
    /** Accumulated revenue from selling ($) */
    totalRevenue: number;
}

/**
 * Grid environment state (day/night cycle, pricing, weather)
 */
export interface GridEnvState {
    /** Current hour of day [0..24) */
    hour: number;
    /** Solar panel output (kW) */
    solarOutput: number;
    /** House electricity demand (kW) */
    houseDemand: number;
    /** Grid electricity price ($/kWh) */
    gridPrice: number;
    /** Cloud cover factor [0..1] (0 = clear, 1 = overcast) */
    cloudCover: number;
}

/**
 * Game state for smart grid demo
 */
export interface GridGameState {
    agents: GridAgent[];
    env: GridEnvState;
    frame: number;
    generation: number;
}

/**
 * Statistics for grid demo
 */
export interface GridStats {
    generation: number;
    best: number;
    avgCost: number;
    avgFitness: number;
}

// ─── Canvas Configuration ───────────────────────────────────────────────────

export const GRID_WIDTH = 900;
export const GRID_HEIGHT = 600;
export const GRID_POPULATION_SIZE = 200;

// ─── Neural Network Topology ────────────────────────────────────────────────

/**
 * Neural network inputs (8):
 *   [0] solarOutput     — current solar generation (normalized kW)
 *   [1] houseDemand     — current house consumption (normalized kW)
 *   [2] batterySoC      — battery state of charge [0..1]
 *   [3] gridPrice       — current electricity price (normalized)
 *   [4] hourSin         — sin(2π * hour / 24) — cyclic time encoding
 *   [5] hourCos         — cos(2π * hour / 24) — cyclic time encoding
 *   [6] priceTrend      — next-hour price delta (normalized)
 *   [7] solarForecast   — expected solar for next hour (normalized)
 */
export const GRID_INPUTS = 8;
export const GRID_HIDDEN = [16, 12];

/**
 * Neural network outputs (3):
 *   [0] charge     — charge battery (from solar or grid)
 *   [1] discharge  — use battery to power house
 *   [2] sell       — sell surplus to grid / idle
 */
export const GRID_OUTPUTS = 3;

// ─── Simulation Parameters ──────────────────────────────────────────────────

/** 24 hours at 1-minute resolution */
export const GRID_MAX_FRAMES = 1440;

/** Battery capacity in kWh */
export const GRID_BATTERY_CAPACITY = 13.5; // ~Tesla Powerwall

/** Peak solar output in kW */
export const GRID_PEAK_SOLAR = 6.0;

/** Charge/discharge efficiency */
export const GRID_BATTERY_EFFICIENCY = 0.92;
