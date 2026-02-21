import { useCallback, useRef } from 'react';
import * as wasm from '../wasm/pkg/gran_prix_wasm';
import {
    VACUUM_POPULATION_SIZE,
    VACUUM_INPUTS,
    VACUUM_OUTPUTS,
    VACUUM_MAX_FRAMES,
    VACUUM_WIDTH,
    VACUUM_HEIGHT,
    VACUUM_CELL_SIZE,
    VACUUM_SIZE,
    VACUUM_MOVE_COST,
    VACUUM_CLEAN_COST,
    VACUUM_CHARGE_RATE,
    VacuumGameState,
    VacuumStats,
    VacuumObstacle,
} from '../types/vacuum';

// ─── Environment Helpers ─────────────────────────────────────────────────────

/** Generate random furniture obstacles that don't overlap the charger */
function generateObstacles(): VacuumObstacle[] {
    const furniture: { w: number; h: number; label: string }[] = [
        { w: 100, h: 60, label: 'Sofa' },
        { w: 70, h: 70, label: 'Table' },
        { w: 40, h: 80, label: 'Shelf' },
        { w: 60, h: 40, label: 'Chair' },
        { w: 50, h: 50, label: 'Cabinet' },
    ];

    const obstacles: VacuumObstacle[] = [];
    const margin = 60; // Keep away from charger area (bottom-left)

    for (const f of furniture) {
        let tries = 0;
        while (tries < 20) {
            const x = margin + Math.random() * (VACUUM_WIDTH - f.w - margin * 2);
            const y = Math.random() * (VACUUM_HEIGHT - f.h - margin);

            // Don't overlap charger zone (bottom-left 80x80)
            if (x < 90 && y > VACUUM_HEIGHT - 90) {
                tries++;
                continue;
            }

            // Don't overlap other obstacles
            const overlaps = obstacles.some(o =>
                x < o.x + o.w + 10 && x + f.w + 10 > o.x &&
                y < o.y + o.h + 10 && y + f.h + 10 > o.y
            );

            if (!overlaps) {
                obstacles.push({ x, y, w: f.w, h: f.h, label: f.label });
                break;
            }
            tries++;
        }
    }

    return obstacles;
}

/** Generate the initial dust map with clusters */
function generateDustMap(cols: number, rows: number, obstacles: VacuumObstacle[]): boolean[] {
    const dustMap = new Array(cols * rows).fill(false);

    // Base random distribution (~55%)
    for (let i = 0; i < dustMap.length; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const px = col * VACUUM_CELL_SIZE + VACUUM_CELL_SIZE / 2;
        const py = row * VACUUM_CELL_SIZE + VACUUM_CELL_SIZE / 2;

        // Don't place dust inside obstacles
        const insideObstacle = obstacles.some(o =>
            px >= o.x && px <= o.x + o.w && py >= o.y && py <= o.y + o.h
        );

        // Don't place dust on charger zone
        const onCharger = px < 60 && py > VACUUM_HEIGHT - 60;

        if (!insideObstacle && !onCharger) {
            dustMap[i] = Math.random() < 0.55;
        }
    }

    // Add 3-5 high-density clusters
    const numClusters = 3 + Math.floor(Math.random() * 3);
    for (let c = 0; c < numClusters; c++) {
        const cx = Math.floor(Math.random() * cols);
        const cy = Math.floor(Math.random() * rows);
        const radius = 2 + Math.floor(Math.random() * 3);

        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const nx = cx + dx;
                const ny = cy + dy;
                if (nx >= 0 && nx < cols && ny >= 0 && ny < rows) {
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist <= radius && Math.random() < 0.85) {
                        const idx = ny * cols + nx;
                        const px = nx * VACUUM_CELL_SIZE + VACUUM_CELL_SIZE / 2;
                        const py = ny * VACUUM_CELL_SIZE + VACUUM_CELL_SIZE / 2;
                        const insideObs = obstacles.some(o =>
                            px >= o.x && px <= o.x + o.w && py >= o.y && py <= o.y + o.h
                        );
                        if (!insideObs) {
                            dustMap[idx] = true;
                        }
                    }
                }
            }
        }
    }

    return dustMap;
}

/** Count dirty cells in a sector defined by heading + offset angle */
function sensesDust(
    x: number, y: number, heading: number, angleOffset: number,
    dustMap: boolean[], cols: number, rows: number, sensorRange: number,
): number {
    const angle = heading + angleOffset;
    let dustCount = 0;
    let totalSamples = 0;

    for (let r = 1; r <= sensorRange; r++) {
        // Sample a narrow cone (±15deg)
        for (let spread = -0.25; spread <= 0.25; spread += 0.25) {
            const sx = x + Math.cos(angle + spread) * r * VACUUM_CELL_SIZE;
            const sy = y + Math.sin(angle + spread) * r * VACUUM_CELL_SIZE;
            const col = Math.floor(sx / VACUUM_CELL_SIZE);
            const row = Math.floor(sy / VACUUM_CELL_SIZE);

            if (col >= 0 && col < cols && row >= 0 && row < rows) {
                totalSamples++;
                if (dustMap[row * cols + col]) {
                    dustCount++;
                }
            }
        }
    }

    return totalSamples > 0 ? dustCount / totalSamples : 0;
}

/** Raycast for obstacle distance ahead */
function senseObstacle(
    x: number, y: number, heading: number,
    obstacles: VacuumObstacle[], maxDist: number,
): number {
    const steps = 20;
    const stepSize = maxDist / steps;

    for (let s = 1; s <= steps; s++) {
        const sx = x + Math.cos(heading) * s * stepSize;
        const sy = y + Math.sin(heading) * s * stepSize;

        // Wall check
        if (sx < 0 || sx >= VACUUM_WIDTH || sy < 0 || sy >= VACUUM_HEIGHT) {
            return (s - 1) / steps;
        }

        // Obstacle check
        for (const o of obstacles) {
            if (sx >= o.x && sx <= o.x + o.w && sy >= o.y && sy <= o.y + o.h) {
                return (s - 1) / steps;
            }
        }
    }

    return 1.0; // No obstacle in range
}

/** Check if point collides with any obstacle */
function collidesObstacle(x: number, y: number, radius: number, obstacles: VacuumObstacle[]): boolean {
    for (const o of obstacles) {
        const closestX = Math.max(o.x, Math.min(x, o.x + o.w));
        const closestY = Math.max(o.y, Math.min(y, o.y + o.h));
        const dx = x - closestX;
        const dy = y - closestY;
        if (dx * dx + dy * dy < radius * radius) {
            return true;
        }
    }
    return false;
}

// ─── Hook Interface ──────────────────────────────────────────────────────────

interface UseVacuumGameLoopProps {
    computeVacuum: (inputs: Float32Array) => Float32Array | null;
    evolve: (
        fitnessScores: number[],
        mutationRate: number,
        mutationScale: number,
        strategy: wasm.MutationStrategy,
    ) => void;
    setStats: React.Dispatch<React.SetStateAction<VacuumStats>>;
    mutationRate: number;
    mutationScale: number;
    mutationStrategy: wasm.MutationStrategy;
    onGenerationEnd: (maxFitness: number, avgFitness: number) => void;
}

export function useVacuumGameLoop({
    computeVacuum,
    evolve,
    setStats,
    mutationRate,
    mutationScale,
    mutationStrategy,
    onGenerationEnd,
}: UseVacuumGameLoopProps) {
    const cols = Math.floor(VACUUM_WIDTH / VACUUM_CELL_SIZE);
    const rows = Math.floor(VACUUM_HEIGHT / VACUUM_CELL_SIZE);

    const gameState = useRef<VacuumGameState>({
        agents: [],
        env: {
            dustMap: [],
            totalDust: 0,
            obstacles: [],
            chargerX: 30,
            chargerY: VACUUM_HEIGHT - 30,
            cellSize: VACUUM_CELL_SIZE,
            cols,
            rows,
        },
        frame: 0,
        generation: 1,
    });

    const mutationRateRef = useRef(mutationRate);
    const mutationScaleRef = useRef(mutationScale);
    const mutationStrategyRef = useRef(mutationStrategy);
    mutationRateRef.current = mutationRate;
    mutationScaleRef.current = mutationScale;
    mutationStrategyRef.current = mutationStrategy;

    const isComputing = useRef(false);

    const resetVacuum = useCallback(() => {
        const state = gameState.current;
        const obstacles = generateObstacles();
        const dustMap = generateDustMap(cols, rows, obstacles);
        const totalDust = dustMap.filter(d => d).length;

        state.agents = Array.from({ length: VACUUM_POPULATION_SIZE }, (_, i) => ({
            id: i,
            x: 30 + Math.random() * 20,           // Start near charger
            y: VACUUM_HEIGHT - 30 + Math.random() * 10 - 5,
            heading: Math.random() * Math.PI * 2,
            battery: 1.0,
            dustCleaned: 0,
            wallHits: 0,
            fitness: 0,
            dead: false,
            color: `hsl(${(i / VACUUM_POPULATION_SIZE) * 200 + 140}, 70%, 55%)`,
        }));

        state.env = {
            dustMap,
            totalDust,
            obstacles,
            chargerX: 30,
            chargerY: VACUUM_HEIGHT - 30,
            cellSize: VACUUM_CELL_SIZE,
            cols,
            rows,
        };

        state.frame = 0;
        setStats(s => ({ ...s, avgCleaned: 0 }));
    }, [cols, rows, setStats]);

    const runEvolution = useCallback(() => {
        const state = gameState.current;
        const scores = state.agents.map(a => a.fitness);
        if (scores.length === 0) return;

        const maxFitness = Math.max(...scores);
        const avgFitness = scores.reduce((a, b) => a + b, 0) / scores.length;

        try {
            evolve(scores, mutationRateRef.current, mutationScaleRef.current, mutationStrategyRef.current);
            state.generation++;
            const avgCleaned = state.agents.reduce((s, a) => s + a.dustCleaned, 0) / state.agents.length;
            setStats({
                generation: state.generation,
                best: maxFitness,
                avgCleaned,
                alive: state.agents.filter(a => !a.dead).length,
            });
            onGenerationEnd(maxFitness, avgFitness);
            resetVacuum();
        } catch (e) {
            console.error('VACUUM: evolution error:', e);
        }
    }, [evolve, setStats, onGenerationEnd, resetVacuum]);

    const updatePhysics = useCallback(() => {
        if (isComputing.current) return;
        isComputing.current = true;

        try {
            const state = gameState.current;
            const { agents, env } = state;

            state.frame++;

            // ── Prepare neural inputs for all agents ──
            const aliveAgents = agents.filter(a => !a.dead);
            if (aliveAgents.length === 0) {
                if (state.frame < VACUUM_MAX_FRAMES) {
                    runEvolution();
                }
                return;
            }

            const inputs = new Float32Array(VACUUM_POPULATION_SIZE * VACUUM_INPUTS);
            const maxDist = Math.sqrt(VACUUM_WIDTH * VACUUM_WIDTH + VACUUM_HEIGHT * VACUUM_HEIGHT);
            const sensorRange = 4;

            for (let i = 0; i < VACUUM_POPULATION_SIZE; i++) {
                const agent = agents[i];
                const base = i * VACUUM_INPUTS;

                // Dust sensors (ahead, left, right)
                inputs[base + 0] = sensesDust(agent.x, agent.y, agent.heading, 0, env.dustMap, env.cols, env.rows, sensorRange);
                inputs[base + 1] = sensesDust(agent.x, agent.y, agent.heading, -Math.PI / 3, env.dustMap, env.cols, env.rows, sensorRange);
                inputs[base + 2] = sensesDust(agent.x, agent.y, agent.heading, Math.PI / 3, env.dustMap, env.cols, env.rows, sensorRange);

                // Obstacle sensor
                inputs[base + 3] = senseObstacle(agent.x, agent.y, agent.heading, env.obstacles, 100);

                // Battery
                inputs[base + 4] = agent.battery;

                // Distance to charger (normalized)
                const dxc = env.chargerX - agent.x;
                const dyc = env.chargerY - agent.y;
                const distCharger = Math.sqrt(dxc * dxc + dyc * dyc);
                inputs[base + 5] = Math.min(1, distCharger / maxDist);

                // Angle to charger relative to heading
                const angleToCharger = Math.atan2(dyc, dxc) - agent.heading;
                inputs[base + 6] = Math.sin(angleToCharger); // Normalized [-1..1]

                // Heading encoding
                inputs[base + 7] = Math.sin(agent.heading);
                inputs[base + 8] = Math.cos(agent.heading);
            }

            // ── Forward pass ──
            const outputs = computeVacuum(inputs);
            if (!outputs) return;

            // ── Apply actions ──
            let alive = 0;
            for (let i = 0; i < VACUUM_POPULATION_SIZE; i++) {
                const agent = agents[i];
                if (agent.dead) continue;

                const outBase = i * VACUUM_OUTPUTS;
                const forwardSignal = outputs[outBase + 0];
                const turnLeftSignal = outputs[outBase + 1];
                const turnRightSignal = outputs[outBase + 2];

                // Apply turning
                const turnDelta = (turnRightSignal - turnLeftSignal) * 0.15;
                agent.heading += turnDelta;

                // Normalize heading to [0, 2π]
                agent.heading = ((agent.heading % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

                // Apply forward movement
                const speed = forwardSignal * 3.0;
                const newX = agent.x + Math.cos(agent.heading) * speed;
                const newY = agent.y + Math.sin(agent.heading) * speed;

                // Wall collision
                let hitWall = false;
                let clampedX = newX;
                let clampedY = newY;

                if (newX < VACUUM_SIZE || newX > VACUUM_WIDTH - VACUUM_SIZE) {
                    clampedX = Math.max(VACUUM_SIZE, Math.min(VACUUM_WIDTH - VACUUM_SIZE, newX));
                    hitWall = true;
                }
                if (newY < VACUUM_SIZE || newY > VACUUM_HEIGHT - VACUUM_SIZE) {
                    clampedY = Math.max(VACUUM_SIZE, Math.min(VACUUM_HEIGHT - VACUUM_SIZE, newY));
                    hitWall = true;
                }

                // Obstacle collision
                if (collidesObstacle(clampedX, clampedY, VACUUM_SIZE, env.obstacles)) {
                    hitWall = true;
                    // Revert to old position
                    clampedX = agent.x;
                    clampedY = agent.y;
                }

                if (hitWall) {
                    agent.wallHits++;
                }

                agent.x = clampedX;
                agent.y = clampedY;

                // ── Clean dust at current position ──
                const col = Math.floor(agent.x / VACUUM_CELL_SIZE);
                const row = Math.floor(agent.y / VACUUM_CELL_SIZE);
                if (col >= 0 && col < env.cols && row >= 0 && row < env.rows) {
                    const idx = row * env.cols + col;
                    if (env.dustMap[idx]) {
                        env.dustMap[idx] = false;
                        agent.dustCleaned++;
                        agent.battery -= VACUUM_CLEAN_COST;
                    }
                }

                // ── Battery drain from movement ──
                agent.battery -= speed * VACUUM_MOVE_COST;

                // ── Charging ──
                const dxc = agent.x - env.chargerX;
                const dyc = agent.y - env.chargerY;
                const distSq = dxc * dxc + dyc * dyc;
                if (distSq < 30 * 30) {
                    agent.battery = Math.min(1.0, agent.battery + VACUUM_CHARGE_RATE);
                }

                // ── Battery death ──
                if (agent.battery <= 0) {
                    agent.battery = 0;
                    const onCharger = distSq < 30 * 30;
                    if (!onCharger) {
                        agent.dead = true;
                    }
                }

                // ── Fitness (Competitive Swarm Mathematics) ──
                // In a swarm of 200 agents, the 'fair share' of dirt per agent is totalDust/200.
                // If an agent cleans its fair share (or more), it gets up to full 10.0 points.
                // This preserves Swarm sharing while scaling fitness readable out of 10.
                const fairShare = env.totalDust > 0 ? env.totalDust / VACUUM_POPULATION_SIZE : 1;
                const agentCleanRatio = agent.dustCleaned / fairShare;
                const cleanScore = Math.min(10.0, agentCleanRatio * 10.0);
                
                const batteryBonus = (agent.battery > 0.1 && distSq < 30 * 30) ? 2.0 : 0;
                const wallPenalty = Math.min(agent.wallHits * 0.02, 2.0);
                const deathPenalty = agent.dead ? 3.0 : 0;
                agent.fitness = Math.max(0, cleanScore + batteryBonus - wallPenalty - deathPenalty);

                if (!agent.dead) alive++;
            }

            setStats(s => ({ ...s, alive }));

            // ── End of generation → evolve ──
            if (state.frame >= VACUUM_MAX_FRAMES) {
                runEvolution();
            }
        } finally {
            isComputing.current = false;
        }
    }, [computeVacuum, runEvolution, setStats, cols, rows]);

    return { gameState, resetVacuum, updatePhysics };
}
