import * as wasm from '../../wasm/pkg/gran_prix_wasm';
import {
    VACUUM_WIDTH,
    VACUUM_HEIGHT,
    VACUUM_CELL_SIZE,
    VACUUM_POPULATION_SIZE,
    VACUUM_INPUTS,
    VACUUM_OUTPUTS,
    VACUUM_MAX_FRAMES,
    VACUUM_MOVE_COST,
    VACUUM_CLEAN_COST,
    VACUUM_CHARGE_RATE,
    VacuumObstacle,
} from '../../types/vacuum';
import { SimulationConfig, SimulationState, BaseAgent } from '../../core/simulation/SimulationEngine';

export interface VacuumAgent extends BaseAgent {
    x: number;
    y: number;
    heading: number;
    battery: number;
    dustCleaned: number;
    wallHits: number;
}

export interface VacuumSimulationState extends SimulationState<VacuumAgent> {
    env: {
        dustMap: boolean[];
        totalDust: number;
        obstacles: VacuumObstacle[];
        chargerX: number;
        chargerY: number;
        cellSize: number;
        cols: number;
        rows: number;
    };
}

export interface VacuumStats {
    generation: number;
    best: number;
    avgCleaned: number;
    alive: number;
}

// ─── Internal Helpers (Copied from useVacuumGameLoop.ts logic) ────────────────

function generateObstacles(): VacuumObstacle[] {
    const furniture = [
        { w: 100, h: 60, label: 'Sofa' },
        { w: 70, h: 70, label: 'Table' },
        { w: 40, h: 80, label: 'Shelf' },
        { w: 60, h: 40, label: 'Chair' },
        { w: 50, h: 50, label: 'Cabinet' },
    ];
    const obstacles: VacuumObstacle[] = [];
    const margin = 60;
    for (const f of furniture) {
        let tries = 0;
        while (tries < 20) {
            const x = margin + Math.random() * (VACUUM_WIDTH - f.w - margin * 2);
            const y = Math.random() * (VACUUM_HEIGHT - f.h - margin);
            if (x < 90 && y > VACUUM_HEIGHT - 90) { tries++; continue; }
            const overlaps = obstacles.some(o => x < o.x + o.w + 10 && x + f.w + 10 > o.x && y < o.y + o.h + 10 && y + f.h + 10 > o.y);
            if (!overlaps) { obstacles.push({ x, y, w: f.w, h: f.h, label: f.label }); break; }
            tries++;
        }
    }
    return obstacles;
}

function generateDustMap(cols: number, rows: number, obstacles: VacuumObstacle[]): boolean[] {
    const dustMap = new Array(cols * rows).fill(false);
    for (let i = 0; i < dustMap.length; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const px = col * VACUUM_CELL_SIZE + VACUUM_CELL_SIZE / 2;
        const py = row * VACUUM_CELL_SIZE + VACUUM_CELL_SIZE / 2;
        const insideObstacle = obstacles.some(o => px >= o.x && px <= o.x + o.w && py >= o.y && py <= o.y + o.h);
        const onCharger = px < 60 && py > VACUUM_HEIGHT - 60;
        if (!insideObstacle && !onCharger) dustMap[i] = Math.random() < 0.55;
    }
    const numClusters = 3 + Math.floor(Math.random() * 3);
    for (let c = 0; c < numClusters; c++) {
        const cx = Math.floor(Math.random() * cols);
        const cy = Math.floor(Math.random() * rows);
        const radius = 2 + Math.floor(Math.random() * 3);
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const nx = cx + dx; const ny = cy + dy;
                if (nx >= 0 && nx < cols && ny >= 0 && ny < rows) {
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist <= radius && Math.random() < 0.85) {
                        const idx = ny * cols + nx;
                        const px = nx * VACUUM_CELL_SIZE + VACUUM_CELL_SIZE / 2;
                        const py = ny * VACUUM_CELL_SIZE + VACUUM_CELL_SIZE / 2;
                        const insideObs = obstacles.some(o => px >= o.x && px <= o.x + o.w && py >= o.y && py <= o.y + o.h);
                        if (!insideObs) dustMap[idx] = true;
                    }
                }
            }
        }
    }
    return dustMap;
}

function sensesDust(x: number, y: number, heading: number, angleOffset: number, dustMap: boolean[], cols: number, rows: number, sensorRange: number): number {
    const angle = heading + angleOffset;
    let dustCount = 0; let totalSamples = 0;
    for (let r = 1; r <= sensorRange; r++) {
        for (let spread = -0.25; spread <= 0.25; spread += 0.25) {
            const sx = x + Math.cos(angle + spread) * r * VACUUM_CELL_SIZE;
            const sy = y + Math.sin(angle + spread) * r * VACUUM_CELL_SIZE;
            const col = Math.floor(sx / VACUUM_CELL_SIZE);
            const row = Math.floor(sy / VACUUM_CELL_SIZE);
            if (col >= 0 && col < cols && row >= 0 && row < rows) {
                totalSamples++;
                if (dustMap[row * cols + col]) dustCount++;
            }
        }
    }
    return totalSamples > 0 ? dustCount / totalSamples : 0;
}

function senseObstacle(x: number, y: number, heading: number, obstacles: VacuumObstacle[], maxDist: number): number {
    const steps = 20; const stepSize = maxDist / steps;
    for (let s = 1; s <= steps; s++) {
        const sx = x + Math.cos(heading) * s * stepSize;
        const sy = y + Math.sin(heading) * s * stepSize;
        if (sx < 0 || sx >= VACUUM_WIDTH || sy < 0 || sy >= VACUUM_HEIGHT) return (s - 1) / steps;
        for (const o of obstacles) {
            if (sx >= o.x && sx <= o.x + o.w && sy >= o.y && sy <= o.y + o.h) return (s - 1) / steps;
        }
    }
    return 1.0;
}

function collidesObstacle(x: number, y: number, radius: number, obstacles: VacuumObstacle[]): boolean {
    for (const o of obstacles) {
        const closestX = Math.max(o.x, Math.min(x, o.x + o.w));
        const closestY = Math.max(o.y, Math.min(y, o.y + o.h));
        const dx = x - closestX; const dy = y - closestY;
        if (dx * dx + dy * dy < radius * radius) return true;
    }
    return false;
}

export const vacuumSimulationConfig: SimulationConfig<VacuumAgent, VacuumSimulationState, VacuumStats> = {
    populations: [
        {
            id: 'vacuums',
            size: VACUUM_POPULATION_SIZE,
            inputs: VACUUM_INPUTS,
            outputs: VACUUM_OUTPUTS,
            hidden: [16, 12]
        }
    ],

    mutationRate: 0.08,
    mutationScale: 0.15,
    mutationStrategy: wasm.MutationStrategy.Additive,

    createAgent: (id, popId) => ({
        id,
        popId,
        x: 30 + Math.random() * 20,
        y: VACUUM_HEIGHT - 30 + Math.random() * 10 - 5,
        heading: Math.random() * Math.PI * 2,
        battery: 1.0,
        dustCleaned: 0,
        wallHits: 0,
        fitness: 0,
        dead: false,
        color: `hsl(${(id / VACUUM_POPULATION_SIZE) * 200 + 140}, 70%, 55%)`
    }),

    onReset: (state) => {
        const cols = Math.floor(VACUUM_WIDTH / VACUUM_CELL_SIZE);
        const rows = Math.floor(VACUUM_HEIGHT / VACUUM_CELL_SIZE);
        const obstacles = generateObstacles();
        const dustMap = generateDustMap(cols, rows, obstacles);

        state.env = {
            dustMap,
            totalDust: dustMap.filter(d => d).length,
            obstacles,
            chargerX: 30,
            chargerY: VACUUM_HEIGHT - 30,
            cellSize: VACUUM_CELL_SIZE,
            cols,
            rows
        };
    },

    getInputs: (state, _popId) => {
        const inputs = new Float32Array(VACUUM_POPULATION_SIZE * VACUUM_INPUTS);
        for (let i = 0; i < state.agents.length; i++) {
            const agent = state.agents[i];
            const sensorIdx = i * VACUUM_INPUTS;
            if (agent.dead) {
                inputs.fill(0, sensorIdx, sensorIdx + VACUUM_INPUTS);
                continue;
            }
            inputs[sensorIdx] = agent.battery;
            inputs[sensorIdx + 1] = sensesDust(agent.x, agent.y, agent.heading, -0.6, state.env.dustMap, state.env.cols, state.env.rows, 4);
            inputs[sensorIdx + 2] = sensesDust(agent.x, agent.y, agent.heading, 0, state.env.dustMap, state.env.cols, state.env.rows, 4);
            inputs[sensorIdx + 3] = sensesDust(agent.x, agent.y, agent.heading, 0.6, state.env.dustMap, state.env.cols, state.env.rows, 4);
            inputs[sensorIdx + 4] = senseObstacle(agent.x, agent.y, agent.heading, state.env.obstacles, 60);
            
            const dx = state.env.chargerX - agent.x;
            const dy = state.env.chargerY - agent.y;
            const angleToCharger = Math.atan2(dy, dx);
            inputs[sensorIdx + 5] = Math.cos(angleToCharger - agent.heading);
            inputs[sensorIdx + 6] = Math.sin(angleToCharger - agent.heading);
            inputs[sensorIdx + 7] = Math.min(1.0, Math.sqrt(dx * dx + dy * dy) / 400);
        }
        return inputs;
    },

    updatePhysics: (state, outputsMap) => {
        const outputs = outputsMap.get('vacuums');
        if (!outputs) return;

        for (let i = 0; i < state.agents.length; i++) {
            const agent = state.agents[i];
            if (agent.dead) continue;

            const outIdx = i * VACUUM_OUTPUTS;
            const turn = (outputs[outIdx] * 2 - 1) * 0.15;
            const move = outputs[outIdx + 1] > 0.4 ? (outputs[outIdx + 1] * 3.5) : 0;
            
            agent.heading += turn;
            const nextX = agent.x + Math.cos(agent.heading) * move;
            const nextY = agent.y + Math.sin(agent.heading) * move;

            if (nextX < 0 || nextX >= VACUUM_WIDTH || nextY < 0 || nextY >= VACUUM_HEIGHT || collidesObstacle(nextX, nextY, 7, state.env.obstacles)) {
                agent.wallHits++;
                agent.battery -= 0.01;
            } else {
                agent.x = nextX;
                agent.y = nextY;
                agent.battery -= VACUUM_MOVE_COST;
            }

            const distToCharger = Math.sqrt(Math.pow(agent.x - state.env.chargerX, 2) + Math.pow(agent.y - state.env.chargerY, 2));
            if (distToCharger < 25) agent.battery = Math.min(1.0, agent.battery + VACUUM_CHARGE_RATE);

            const col = Math.floor(agent.x / VACUUM_CELL_SIZE);
            const row = Math.floor(agent.y / VACUUM_CELL_SIZE);
            const cellIdx = row * state.env.cols + col;

            if (state.env.dustMap[cellIdx]) {
                state.env.dustMap[cellIdx] = false;
                agent.dustCleaned++;
                agent.battery -= VACUUM_CLEAN_COST;
            }

            if (agent.battery <= 0) {
                agent.dead = true;
            }

            // Updated fitness: ROI penalized by Drawdown
            agent.fitness = agent.dustCleaned * 100 - agent.wallHits * 5 + (agent.battery > 0 ? agent.battery * 20 : 0);
        }

        if (state.frame >= VACUUM_MAX_FRAMES) {
            state.agents.forEach(a => a.dead = true);
        }
    },

    getStats: (state) => {
        const avgCleaned = state.agents.length > 0 ? state.agents.reduce((s, a) => s + a.dustCleaned, 0) / state.agents.length : 0;
        return {
            generation: state.generation,
            best: state.agents.length > 0 ? Math.max(...state.agents.map(a => a.fitness)) : 0,
            avgCleaned,
            alive: state.agents.filter(a => !a.dead).length
        };
    }
};
