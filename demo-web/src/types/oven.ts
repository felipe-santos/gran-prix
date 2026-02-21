/**
 * Smart Oven Demo Types (IoT Edge AI)
 *
 * Thermodynamic simulation where agents learn to cook different foods
 * by controlling heating elements and convection fans while avoiding burning.
 */

import { BaseAgent } from './common';

/**
 * Food types with different cooking profiles
 */
export enum OvenFoodType {
    Cake = 'Cake',
    Bread = 'Bread',
    Turkey = 'Turkey',
    Pizza = 'Pizza',
}

/**
 * Food cooking profile with thermal properties
 */
export interface OvenFoodProfile {
    type: OvenFoodType;
    /** Ideal core temperature (°C) */
    targetCore: number;
    /** Surface temperature where it starts to burn (°C) */
    burnTemp: number;
    /** How fast heat transfers from surface to core (lower = more inertia/slower) */
    coreConductivity: number;
    /** How fast surface heats from air (higher = faster) */
    surfaceConductivity: number;
    /** Moisture loss rate at high temps */
    moistureLossRate: number;
}

/**
 * Predefined cooking profiles for each food type
 */
export const OVEN_FOODS: Record<OvenFoodType, OvenFoodProfile> = {
    [OvenFoodType.Cake]: {
        type: OvenFoodType.Cake,
        targetCore: 95,
        burnTemp: 160,
        coreConductivity: 0.05,
        surfaceConductivity: 0.15,
        moistureLossRate: 0.01,
    },
    [OvenFoodType.Bread]: {
        type: OvenFoodType.Bread,
        targetCore: 95,
        burnTemp: 210,
        coreConductivity: 0.03, // Thick crust, slow heat transfer
        surfaceConductivity: 0.1,
        moistureLossRate: 0.005,
    },
    [OvenFoodType.Turkey]: {
        type: OvenFoodType.Turkey,
        targetCore: 75,
        burnTemp: 180,
        coreConductivity: 0.015, // Huge mass, very slow core heating
        surfaceConductivity: 0.08,
        moistureLossRate: 0.02,
    },
    [OvenFoodType.Pizza]: {
        type: OvenFoodType.Pizza,
        targetCore: 85,
        burnTemp: 240,
        coreConductivity: 0.2, // Thin, heats very fast
        surfaceConductivity: 0.3,
        moistureLossRate: 0.03,
    },
};

/**
 * Oven agent controlling heating elements
 */
export interface OvenAgent extends BaseAgent {
    // ─── Thermodynamic State ───────────────────────────────────────────────
    /** Internal air temperature of the oven enclosure (°C) */
    airTemp: number;
    /** Temperature of the food's outer crust/surface (°C) */
    surfaceTemp: number;
    /** Temperature of the food's deep center (°C) */
    coreTemp: number;
    /** Remaining moisture content (1.0 = 100%, 0.0 = dry/ruined) */
    moisture: number;

    // ─── Control Outputs (Actions) ─────────────────────────────────────────
    /** Top heating element power [0..1] */
    topHeater: number;
    /** Bottom heating element power [0..1] */
    bottomHeater: number;
    /** Convection fan power [0..1] */
    fan: number;

    // ─── Status Flags ──────────────────────────────────────────────────────
    /** Did the core reach target temp? */
    cooked: boolean;
    /** Did the surface exceed burn temp? */
    burnt: boolean;
    /** Total energy used (integral of heater power over time) */
    energyUsed: number;

    /** Active food profile being cooked this generation */
    food: OvenFoodProfile;
}

/**
 * Game state for oven demo
 */
export interface OvenGameState {
    agents: OvenAgent[];
    frame: number;
    generation: number;
    /** The food type all agents are trying to cook this generation */
    currentFoodType: OvenFoodType;
    /** Frames passed after all agents finished (to simulate cooldown) */
    restingFrames: number;
}

/**
 * Statistics for oven demo
 */
export interface OvenStats {
    generation: number;
    bestFitness: number;
    avgFitness: number;
    bestCoreTemp: number;
    /** % success for each food type */
    successRates: Record<OvenFoodType, number>;
}

// ─── Neural Network Topology ────────────────────────────────────────────────

/**
 * 11 Inputs:
 * [0] Air Temp (normalized 0-300C)
 * [1] Surface Temp (normalized 0-300C)
 * [2] Core Temp (normalized 0-100C)
 * [3] Distance to Target Core (normalized)
 * [4] Distance to Burn Temp (normalized)
 * [5] Time Progress (% of max frames)
 * [6] Is Cake (1 or 0)
 * [7] Is Bread (1 or 0)
 * [8] Is Turkey (1 or 0)
 * [9] Is Pizza (1 or 0)
 * [10] Moisture level [0..1]
 */
export const OVEN_INPUTS = 11;
export const OVEN_HIDDEN = [12, 8]; // Now supporting multiple layers Correctly!

/**
 * 3 Outputs:
 * [0] Top Heater Power
 * [1] Bottom Heater Power
 * [2] Fan Power
 */
export const OVEN_OUTPUTS = 3;

// ─── Simulation Parameters ──────────────────────────────────────────────────

export const OVEN_POPULATION_SIZE = 200;
export const OVEN_MAX_FRAMES = 4800;

export const OVEN_AMBIENT_TEMP = 25.0; // Room temp (°C)
export const OVEN_MAX_TEMP = 300.0;    // Absolute max oven capacity
