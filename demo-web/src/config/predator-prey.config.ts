/**
 * Predator-Prey Configuration - Co-evolution Demo
 *
 * Configuration for multi-agent evolutionary arms race between
 * predators (foxes) and prey (rabbits).
 */

import { MutationStrategy } from '../wasm/pkg/gran_prix_wasm';

/**
 * Predator evolution parameters
 */
export const PREDATOR_EVOLUTION_CONFIG = {
    /** Mutation rate for predators */
    mutationRate: 0.18,

    /** Mutation magnitude */
    mutationScale: 0.5,

    /** Additive mutation */
    mutationStrategy: MutationStrategy.Additive,

    /** Elite predators to preserve */
    eliteCount: 2,
} as const;

/**
 * Prey evolution parameters
 */
export const PREY_EVOLUTION_CONFIG = {
    /** Mutation rate for prey (slightly higher for faster adaptation) */
    mutationRate: 0.2,

    /** Mutation magnitude */
    mutationScale: 0.5,

    /** Additive mutation */
    mutationStrategy: MutationStrategy.Additive,

    /** Elite prey to preserve */
    eliteCount: 5,
} as const;

/**
 * Predator physics and abilities
 */
export const PREDATOR_PHYSICS_CONFIG = {
    /** Maximum speed */
    maxSpeed: 4.5,

    /** Acceleration */
    acceleration: 0.3,

    /** Turn rate (radians/frame) */
    turnRate: 0.15,

    /** Vision range (px) */
    visionRange: 200,

    /** Catch radius (must be this close to eat) */
    catchRadius: 15,

    /** Energy drain per frame */
    energyDrain: 0.002,

    /** Energy gained from eating prey */
    energyFromFood: 0.4,

    /** Initial energy */
    initialEnergy: 1.0,
} as const;

/**
 * Prey physics and abilities
 */
export const PREY_PHYSICS_CONFIG = {
    /** Maximum speed (faster than predators) */
    maxSpeed: 5.0,

    /** Acceleration */
    acceleration: 0.35,

    /** Turn rate */
    turnRate: 0.18,

    /** Vision range */
    visionRange: 250,

    /** Flock cohesion range */
    flockRange: 80,

    /** Energy drain per frame */
    energyDrain: 0.001,

    /** Energy regeneration while safe */
    energyRegen: 0.0005,

    /** Initial energy */
    initialEnergy: 1.0,
} as const;

/**
 * Fitness function weights
 */
export const PREDATOR_FITNESS_CONFIG = {
    /** Points per prey eaten */
    killReward: 100.0,

    /** Points per frame survived */
    survivalReward: 0.1,

    /** Penalty for death by starvation */
    starvationPenalty: 20.0,
} as const;

export const PREY_FITNESS_CONFIG = {
    /** Points per frame survived */
    survivalReward: 1.0,

    /** Bonus for staying near flock */
    flockBonus: 0.05,

    /** Penalty for being eaten */
    deathPenalty: 0,

    /** Bonus for evasion (close call with predator) */
    evasionBonus: 5.0,
} as const;

/**
 * Environment parameters
 */
export const PREDATOR_PREY_ENV_CONFIG = {
    /** Co-evolution mode (both populations evolve simultaneously) */
    coevolution: true,

    /** Re-spawn prey during simulation */
    preyRespawn: false,

    /** Re-spawn predators during simulation */
    predatorRespawn: false,

    /** Wall bounce elasticity */
    wallBounce: 0.8,
} as const;
