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

// ─── Flappy Bird Demo ───────────────────────────────────────────────────────

export interface FlappyBird {
    id: number;
    /** Vertical centre of the bird (0 = top of canvas) */
    y: number;
    /** Vertical velocity (positive = falling) */
    vy: number;
    dead: boolean;
    fitness: number;
    color: string;
}

export interface FlappyPipe {
    /** Left edge x-position */
    x: number;
    /** Bottom of the top pipe */
    gapTop: number;
    /** Top of the bottom pipe */
    gapBottom: number;
    /** Whether this pipe has been passed (for bonus scoring) */
    passed: boolean;
}

export interface FlappyGameState {
    birds: FlappyBird[];
    pipes: FlappyPipe[];
    score: number;
    generation: number;
    speed: number;
}

export interface FlappyStats {
    score: number;
    generation: number;
    best: number;
    alive: number;
}

// Canvas dimensions (intentionally same as Cars so canvas sizes are consistent)
export const FLAPPY_WIDTH = 800;
export const FLAPPY_HEIGHT = 400;
export const FLAPPY_BIRD_SIZE = 18;
export const FLAPPY_PIPE_WIDTH = 60;
/** Vertical gap between top and bottom pipes */
export const FLAPPY_GAP_SIZE = 130;
/** Number of WASM inputs per bird: [dy_top, dy_bottom, bird_y_norm, vy_norm] */
export const FLAPPY_INPUTS = 4;
export const FLAPPY_POPULATION_SIZE = 200;

// ─── Bipedal Walker Demo ────────────────────────────────────────────────────

export interface WalkerAgent {
    id: number;
    /** Horizontal distance traveled from spawn (metres, planck scale) */
    distance: number;
    dead: boolean;
    fitness: number;
    color: string;
}

export interface WalkerGameState {
    agents: WalkerAgent[];
    /** Frame counter within current generation */
    frame: number;
    generation: number;
}

export interface WalkerStats {
    generation: number;
    alive: number;
    best: number;
    avgDistance: number;
}

// Canvas dimensions — taller than Flappy/Cars to show walking action vertically
export const WALKER_WIDTH = 800;
export const WALKER_HEIGHT = 500;

/** Number of simultaneous learning agents */
export const WALKER_POPULATION_SIZE = 50;

/**
 * Neural network inputs (10):
 *   [0] body_angle         — torso tilt (radians, normalized)
 *   [1] body_angular_vel   — torso angular velocity
 *   [2] left_hip_angle     — left hip joint angle
 *   [3] left_hip_vel       — left hip angular velocity
 *   [4] left_knee_angle    — left knee joint angle
 *   [5] left_knee_vel      — left knee angular velocity
 *   [6] right_hip_angle    — right hip joint angle
 *   [7] right_hip_vel      — right hip angular velocity
 *   [8] right_knee_angle   — right knee joint angle
 *   [9] right_knee_vel     — right knee angular velocity
 */
export const WALKER_INPUTS = 10;

/** Hidden layer size — larger than Flappy because motor coordination is harder */
export const WALKER_HIDDEN = 12;

/**
 * Neural network outputs (4 continuous):
 *   [0] left_hip_torque    — mapped to [-1, 1] motor speed
 *   [1] left_knee_torque   — mapped to [-1, 1] motor speed
 *   [2] right_hip_torque   — mapped to [-1, 1] motor speed
 *   [3] right_knee_torque  — mapped to [-1, 1] motor speed
 */
export const WALKER_OUTPUTS = 4;

/** Maximum frames per generation before forced evolution */
export const WALKER_MAX_FRAMES = 600;

// ─── Predator vs Prey Demo (Co-evolution) ───────────────────────────────────

export interface PredatorAgent { // Fox
    id: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    energy: number;     // Loses energy over time, gains from eating
    fitness: number;    // +1 for eating, +0.1 for surviving
    dead: boolean;
    color: string;
}

export interface PreyAgent { // Rabbit
    id: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    energy: number;     // Loses energy running, regains while resting
    fitness: number;    // +1 per frame survived
    dead: boolean;
    color: string;
}

export interface PredatorPreyGameState {
    predators: PredatorAgent[];
    prey: PreyAgent[];
    frame: number;
    generation: number;
}

export interface PredatorPreyStats {
    generation: number;
    predatorsAlive: number;
    preyAlive: number;
    predatorBest: number;
    preyBest: number;
}

// Larger arena to allow flocking and chasing
export const PREDATOR_PREY_WIDTH = 800;
export const PREDATOR_PREY_HEIGHT = 800;
export const PREDATOR_SIZE = 16;
export const PREY_SIZE = 10;

export const PREDATOR_POPULATION_SIZE = 30;
export const PREY_POPULATION_SIZE = 150;

/**
 * Predator Inputs (7):
 * [0] distance to nearest prey (normalized)
 * [1] angle to nearest prey
 * [2] current vx (normalized)
 * [3] current vy (normalized)
 * [4] distance to closest wall (normalized)
 * [5] current energy (normalized)
 * [6] constant bias / random noise
 */
export const PREDATOR_INPUTS = 7;
export const PREDATOR_HIDDEN = 12;

/**
 * Predator Outputs (2):
 * [0] thrust (accelerate)
 * [1] angular acceleration (turn left/right)
 */
export const PREDATOR_OUTPUTS = 2;

/**
 * Prey Inputs (7):
 * [0] distance to nearest predator (normalized)
 * [1] angle to nearest predator
 * [2] current vx (normalized)
 * [3] current vy (normalized)
 * [4] distance to closest wall (normalized)
 * [5] current energy (normalized)
 * [6] distance to nearest flock member (rabbit)
 */
export const PREY_INPUTS = 7;
export const PREY_HIDDEN = 12;

/**
 * Prey Outputs (2):
 * [0] thrust (accelerate)
 * [1] angular acceleration (turn left/right)
 */
export const PREY_OUTPUTS = 2;

/** Maximum frames before forced generation cycle (to keep the loop going if survival is too good) */
export const PREDATOR_PREY_MAX_FRAMES = 1200;

// ─── Drone Stabilizer Demo (PID vs Neural) ──────────────────────────────────

export interface DroneAgent {
    id: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    fitness: number;
    dead: boolean;
    color: string;
}

export interface PidDroneAgent {
    x: number;
    y: number;
    vx: number;
    vy: number;
    integralX: number;
    integralY: number;
    prevErrorX: number;
    prevErrorY: number;
    color: string;
}

export interface DroneGameState {
    drones: DroneAgent[];
    pidDrone: PidDroneAgent;
    targetX: number;
    targetY: number;
    windX: number;
    windY: number;
    frame: number;
    generation: number;
}

export interface DroneStats {
    generation: number;
    alive: number;
    best: number;
    avgFitness: number;
}

// Canvas dimensions
export const DRONE_WIDTH = 800;
export const DRONE_HEIGHT = 600;

export const DRONE_SIZE = 20;
export const TARGET_RADIUS = 30;

export const DRONE_POPULATION_SIZE = 200;

/**
 * Neural network inputs (4):
 *   [0] distBoxX      — distance to target X (normalized)
 *   [1] distBoxY      — distance to target Y (normalized)
 *   [2] vx            — velocity X (normalized)
 *   [3] vy            — velocity Y (normalized)
 */
export const DRONE_INPUTS = 4;
export const DRONE_HIDDEN = 8;

/**
 * Neural network outputs (2):
 *   [0] thrustX       — mapped to [-1, 1] force X
 *   [1] thrustY       — mapped to [-1, 1] force Y (opposes gravity)
 */
export const DRONE_OUTPUTS = 2;

export const DRONE_MAX_FRAMES = 1000;

// ─── Smart Grid Optimization Demo ───────────────────────────────────────────

export interface GridAgent {
    id: number;
    /** Battery State of Charge [0..1] */
    batterySoC: number;
    /** Accumulated electricity cost ($) */
    totalCost: number;
    /** Accumulated revenue from selling ($) */
    totalRevenue: number;
    /** Fitness score for this generation */
    fitness: number;
    /** Agent killed (e.g. battery fault) */
    dead: boolean;
    /** HSL color for rendering */
    color: string;
}

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

export interface GridGameState {
    agents: GridAgent[];
    env: GridEnvState;
    frame: number;
    generation: number;
}

export interface GridStats {
    generation: number;
    best: number;
    avgCost: number;
    avgFitness: number;
}

// Canvas dimensions
export const GRID_WIDTH = 900;
export const GRID_HEIGHT = 600;

export const GRID_POPULATION_SIZE = 200;

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
export const GRID_HIDDEN = 10;

/**
 * Neural network outputs (3):
 *   [0] charge     — charge battery (from solar or grid)
 *   [1] discharge  — use battery to power house
 *   [2] sell       — sell surplus to grid / idle
 */
export const GRID_OUTPUTS = 3;

/** 24 hours at 1-minute resolution */
export const GRID_MAX_FRAMES = 1440;

/** Battery capacity in kWh */
export const GRID_BATTERY_CAPACITY = 13.5; // ~Tesla Powerwall

/** Peak solar output in kW */
export const GRID_PEAK_SOLAR = 6.0;

/** Charge/discharge efficiency */
export const GRID_BATTERY_EFFICIENCY = 0.92;

// ─── AI Trader Evolution Demo ───────────────────────────────────────────────

export interface TraderAgent {
    id: number;
    /** Current capital ($) */
    capital: number;
    /** Position: -1 short, 0 cash, 1 long */
    position: -1 | 0 | 1;
    /** Price at which current position was entered */
    entryPrice: number;
    /** Peak capital reached (for drawdown tracking) */
    peakCapital: number;
    /** Maximum drawdown encountered [0..1] */
    maxDrawdown: number;
    /** Number of trades executed */
    tradeCount: number;
    /** Fitness score for this generation */
    fitness: number;
    /** Agent killed (bankrupt) */
    dead: boolean;
    /** HSL color for rendering */
    color: string;
}

export interface Candle {
    open: number;
    high: number;
    low: number;
    close: number;
}

export interface TraderEnvState {
    /** Full price history (candles) */
    candles: Candle[];
    /** Current asset price */
    currentPrice: number;
    /** RSI(7) [0..100] */
    rsi: number;
    /** SMA(7) - SMA(25) normalized */
    smaCrossover: number;
    /** Average True Range (7) normalized */
    atr: number;
    /** Current tick/candle index */
    tick: number;
}

export interface TraderGameState {
    agents: TraderAgent[];
    env: TraderEnvState;
    /** Best agent's trade history for rendering markers */
    bestTrades: { tick: number; action: 'buy' | 'sell'; price: number }[];
    frame: number;
    generation: number;
}

export interface TraderStats {
    generation: number;
    bestROI: number;
    avgROI: number;
    bestDrawdown: number;
    alive: number;
}

// Canvas dimensions
export const TRADER_WIDTH = 900;
export const TRADER_HEIGHT = 600;

export const TRADER_POPULATION_SIZE = 200;

/**
 * Neural network inputs (7):
 *   [0] logReturn      — log(price / prevPrice) normalized
 *   [1] rsi            — RSI(7) normalized to [-1, 1]
 *   [2] smaCrossover   — (SMA7 - SMA25) / price, normalized
 *   [3] atr            — ATR(7) / price, normalized volatility
 *   [4] positionState  — current position (-1, 0, 1)
 *   [5] openPnL        — unrealized profit/loss (normalized)
 *   [6] drawdown       — current drawdown from peak [0..1]
 */
export const TRADER_INPUTS = 7;
export const TRADER_HIDDEN = 10;

/**
 * Neural network outputs (3):
 *   [0] buy   — enter or hold long position
 *   [1] sell  — exit position or enter short
 *   [2] hold  — do nothing
 */
export const TRADER_OUTPUTS = 3;

/** Number of candles per generation */
export const TRADER_MAX_FRAMES = 500;

/** Starting capital for each agent */
export const TRADER_INITIAL_CAPITAL = 10000;

/** Fee rate per trade (0.1%) */
export const TRADER_FEE_RATE = 0.001;

// ─── Smart Vacuum Cleaner Demo ──────────────────────────────────────────────

export interface VacuumAgent {
    id: number;
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
    /** Fitness score for this generation */
    fitness: number;
    /** Agent killed (battery died away from charger) */
    dead: boolean;
    /** HSL color for rendering */
    color: string;
}

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

export interface VacuumGameState {
    agents: VacuumAgent[];
    env: VacuumEnvState;
    frame: number;
    generation: number;
}

export interface VacuumStats {
    generation: number;
    best: number;
    avgCleaned: number;
    alive: number;
}

// Canvas dimensions
export const VACUUM_WIDTH = 800;
export const VACUUM_HEIGHT = 600;

export const VACUUM_SIZE = 12;

export const VACUUM_POPULATION_SIZE = 200;

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
export const VACUUM_HIDDEN = 10;

/**
 * Neural network outputs (3):
 *   [0] forward   — move forward intensity [0..1]
 *   [1] turnLeft  — turn left intensity [0..1]
 *   [2] turnRight — turn right intensity [0..1]
 */
export const VACUUM_OUTPUTS = 3;

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

// ─── Smart Oven Demo (IoT Edge AI) ──────────────────────────────────────────

export enum OvenFoodType {
    Cake = 'Cake',
    Bread = 'Bread',
    Turkey = 'Turkey',
    Pizza = 'Pizza',
}

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

export interface OvenAgent {
    id: number;
    /** Current fitness score */
    fitness: number;

    // — Thermodynamic State —
    /** Internal air temperature of the oven enclosure (°C) */
    airTemp: number;
    /** Temperature of the food's outer crust/surface (°C) */
    surfaceTemp: number;
    /** Temperature of the food's deep center (°C) */
    coreTemp: number;
    /** Remaining moisture content (1.0 = 100%, 0.0 = dry/ruined) */
    moisture: number;

    // — Control Outputs (Actions) —
    /** Top heating element power [0..1] */
    topHeater: number;
    /** Bottom heating element power [0..1] */
    bottomHeater: number;
    /** Convection fan power [0..1] */
    fan: number;

    // — Status Flags —
    /** Did the core reach target temp? */
    cooked: boolean;
    /** Did the surface exceed burn temp? */
    burnt: boolean;
    /** Total energy used (integral of heater power over time) */
    energyUsed: number;

    /** Active food profile being cooked this generation */
    food: OvenFoodProfile;
    color: string;
}

export interface OvenGameState {
    agents: OvenAgent[];
    frame: number;
    generation: number;
    /** The food type all agents are trying to cook this generation */
    currentFoodType: OvenFoodType;
    /** Frames passed after all agents finished (to simulate cooldown) */
    restingFrames: number;
}

export interface OvenStats {
    generation: number;
    bestFitness: number;
    avgFitness: number;
    bestCoreTemp: number;
    successRates: Record<OvenFoodType, number>; // % success for each food type
}

// Neural Network Topology
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
export const OVEN_HIDDEN = 12;
/**
 * 3 Outputs:
 * [0] Top Heater Power
 * [1] Bottom Heater Power
 * [2] Fan Power
 */
export const OVEN_OUTPUTS = 3;

export const OVEN_POPULATION_SIZE = 200;
export const OVEN_MAX_FRAMES = 4800;

export const OVEN_AMBIENT_TEMP = 25.0; // Room temp (°C)
export const OVEN_MAX_TEMP = 300.0;    // Absolute max oven capacity
