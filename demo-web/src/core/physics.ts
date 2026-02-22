/**
 * Professional Physics & Control Utilities for Gran-Prix
 */

/**
 * AABB Collision detection
 */
export interface Rect {
    x: number;
    y: number;
    width: number; // Changed from w
    height: number; // Changed from h
}

export function checkCollision(r1: Rect, r2: Rect): boolean {
    return (
        r1.x < r2.x + r2.width &&
        r1.x + r1.width > r2.x &&
        r1.y < r2.y + r2.height &&
        r1.y + r1.height > r2.y
    );
}

/**
 * PID Controller Implementation
 */
export class PIDController {
    integral: number = 0;
    prevError: number = 0;

    constructor(
        public kp: number,
        public ki: number,
        public kd: number
    ) {}

    update(error: number): number {
        this.integral += error;
        const derivative = error - this.prevError;
        const output = this.kp * error + this.ki * this.integral + this.kd * derivative;
        this.prevError = error;
        return output;
    }

    reset() {
        this.integral = 0;
        this.prevError = 0;
    }
}

/**
 * Thermodynamics utilities
 */
export interface ThermalState {
    air: number;
    surface: number;
    core: number;
    moisture: number;
}

export function updateThermodynamics(
    state: ThermalState,
    ambient: number,
    heaters: number,
    fan: number,
    thermalMass: number,
    moistureLossRate: number
): ThermalState {
    // Basic heat transfer model
    const airHeat = (heaters * 2.0) - (fan * 1.5) - (state.air - ambient) * 0.1;
    const newAir = state.air + airHeat;

    const surfaceTransfer = (newAir - state.surface) * 0.05 / thermalMass;
    const coreTransfer = (state.surface - state.core) * 0.02 / thermalMass;

    return {
        air: newAir,
        surface: state.surface + surfaceTransfer,
        core: state.core + coreTransfer,
        moisture: Math.max(0, state.moisture - (state.surface > 100 ? (state.surface - 100) * moistureLossRate : 0))
    };
}
