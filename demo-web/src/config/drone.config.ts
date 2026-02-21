/**
 * Drone Configuration - Drone Stabilizer Demo
 *
 * Configuration for drone stabilization simulation comparing
 * neural networks against classical PID control.
 */

import { MutationStrategy } from '../wasm/pkg/gran_prix_wasm';

/**
 * Evolution hyperparameters for drone control learning
 */
export const DRONE_EVOLUTION_CONFIG = {
    /** Probability of weight mutation */
    mutationRate: 0.15,

    /** Magnitude of weight changes (lower for fine control) */
    mutationScale: 0.4,

    /** Additive mutation for smooth control evolution */
    mutationStrategy: MutationStrategy.Additive,

    /** Elite agents to preserve */
    eliteCount: 5,
} as const;

/**
 * Simulation physics parameters
 */
export const DRONE_SIMULATION_CONFIG = {
    /** Gravity force (downward) */
    gravity: 0.3,

    /** Wind change frequency (frames) */
    windChangeInterval: 120,

    /** Maximum wind force */
    maxWindForce: 1.5,

    /** Drone mass (affects inertia) */
    droneMass: 1.0,

    /** Drag coefficient */
    dragCoefficient: 0.98,
} as const;

/**
 * PID Controller tuning (for comparison baseline)
 */
export const DRONE_PID_CONFIG = {
    /** Proportional gain */
    kp: 0.15,

    /** Integral gain */
    ki: 0.001,

    /** Derivative gain */
    kd: 0.3,

    /** Integral windup limit */
    integralLimit: 50,
} as const;

/**
 * Fitness function weights
 */
export const DRONE_FITNESS_CONFIG = {
    /** Reward for staying near target */
    proximityReward: 1.0,

    /** Penalty for distance from target */
    distancePenalty: 0.1,

    /** Penalty for high velocity (instability) */
    velocityPenalty: 0.05,

    /** Bonus for hovering (low velocity + near target) */
    hoverBonus: 2.0,

    /** Distance threshold for "near target" (px) */
    targetThreshold: 30,
} as const;
