import { useCallback, useRef } from 'react';
import * as wasm from '../wasm/pkg/gran_prix_wasm';
import {
    GRID_POPULATION_SIZE,
    GRID_INPUTS,
    GRID_OUTPUTS,
    GRID_MAX_FRAMES,
    GRID_BATTERY_CAPACITY,
    GRID_PEAK_SOLAR,
    GRID_BATTERY_EFFICIENCY,
    GridGameState,
    GridStats,
} from '../types';

// ─── Environment Model ───────────────────────────────────────────────────────

/** Realistic daily demand curve (kW) — peaks at morning & evening */
function houseDemandAt(hour: number): number {
    // Base load ~0.5 kW, morning peak ~2.5 kW, evening peak ~3.5 kW
    const base = 0.5;
    const morningPeak = 2.0 * Math.exp(-0.5 * ((hour - 7.5) / 1.2) ** 2);
    const eveningPeak = 3.0 * Math.exp(-0.5 * ((hour - 19.5) / 1.8) ** 2);
    return base + morningPeak + eveningPeak;
}

/** Solar output (kW) — bell curve centered at noon, zero at night */
function solarOutputAt(hour: number, cloudCover: number): number {
    if (hour < 5.5 || hour > 19.5) return 0;
    const raw = Math.sin(Math.PI * (hour - 5.5) / 14.0);
    return Math.max(0, raw * GRID_PEAK_SOLAR * (1 - cloudCover * 0.75));
}

/** Time-of-use pricing ($/kWh) */
function gridPriceAt(hour: number): number {
    // Off-peak: $0.08, mid-peak: $0.15, peak: $0.30
    if (hour < 6 || hour >= 22) return 0.08;       // overnight
    if (hour >= 6 && hour < 10) return 0.15;        // morning mid
    if (hour >= 10 && hour < 17) return 0.12;       // daytime
    if (hour >= 17 && hour < 21) return 0.30;       // evening peak
    return 0.15;                                     // evening mid
}

/** Feed-in tariff — what the grid pays for surplus (always < buy price) */
function sellPriceAt(hour: number): number {
    return gridPriceAt(hour) * 0.4; // Grid pays ~40% of retail
}

/** Get price trend: delta between current and next-hour price */
function priceTrend(hour: number): number {
    const nextHour = (hour + 1) % 24;
    return (gridPriceAt(nextHour) - gridPriceAt(hour)) / 0.30; // Normalize by max price
}

/** Solar forecast: expected solar output next hour */
function solarForecast(hour: number, cloudCover: number): number {
    const nextHour = Math.min(hour + 1, 23.99);
    return solarOutputAt(nextHour, cloudCover) / GRID_PEAK_SOLAR; // Normalized
}

// ─── Hook Interface ──────────────────────────────────────────────────────────

interface UseSmartGridGameLoopProps {
    computeGrid: (inputs: Float32Array) => Float32Array | null;
    evolve: (
        fitnessScores: number[],
        mutationRate: number,
        mutationScale: number,
        strategy: wasm.MutationStrategy,
    ) => void;
    setStats: React.Dispatch<React.SetStateAction<GridStats>>;
    mutationRate: number;
    mutationScale: number;
    mutationStrategy: wasm.MutationStrategy;
    onGenerationEnd: (maxFitness: number, avgFitness: number) => void;
}

export function useSmartGridGameLoop({
    computeGrid,
    evolve,
    setStats,
    mutationRate,
    mutationScale,
    mutationStrategy,
    onGenerationEnd,
}: UseSmartGridGameLoopProps) {
    const gameState = useRef<GridGameState>({
        agents: [],
        env: { hour: 0, solarOutput: 0, houseDemand: 0.5, gridPrice: 0.08, cloudCover: 0 },
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

    const resetGrid = useCallback(() => {
        const state = gameState.current;
        const initialCloudCover = Math.random() * 0.5; // Partly cloudy

        state.agents = Array.from({ length: GRID_POPULATION_SIZE }, (_, i) => ({
            id: i,
            batterySoC: 0.5, // Start at 50% charge
            totalCost: 0,
            totalRevenue: 0,
            fitness: 0,
            dead: false,
            color: `hsl(${(i / GRID_POPULATION_SIZE) * 120 + 100}, 70%, 55%)`, // Green-cyan palette
        }));

        state.env = {
            hour: 0,
            solarOutput: 0,
            houseDemand: houseDemandAt(0),
            gridPrice: gridPriceAt(0),
            cloudCover: initialCloudCover,
        };

        state.frame = 0;
        setStats(s => ({ ...s, avgCost: 0 }));
    }, [setStats]);

    const runEvolution = useCallback(() => {
        const state = gameState.current;
        const scores = state.agents.map(a => a.fitness);
        if (scores.length === 0) return;

        const maxFitness = Math.max(...scores);
        const avgFitness = scores.reduce((a, b) => a + b, 0) / scores.length;

        try {
            evolve(scores, mutationRateRef.current, mutationScaleRef.current, mutationStrategyRef.current);
            state.generation++;
            const avgCost = state.agents.reduce((s, a) => s + a.totalCost, 0) / state.agents.length;
            setStats({
                generation: state.generation,
                best: maxFitness,
                avgCost,
                avgFitness,
            });
            onGenerationEnd(maxFitness, avgFitness);
            resetGrid();
        } catch (e) {
            console.error('GRID: evolution error:', e);
        }
    }, [evolve, setStats, onGenerationEnd, resetGrid]);

    const updatePhysics = useCallback(() => {
        if (isComputing.current) return;
        isComputing.current = true;

        try {
            const state = gameState.current;
            const { agents, env } = state;

            // ── Advance time ──
            state.frame++;
            const hour = (state.frame / GRID_MAX_FRAMES) * 24.0; // 0..24
            env.hour = hour;

            // Random cloud drift
            env.cloudCover = Math.max(0, Math.min(1,
                env.cloudCover + (Math.random() - 0.5) * 0.02
            ));

            // Update environment
            env.solarOutput = solarOutputAt(hour, env.cloudCover);
            env.houseDemand = houseDemandAt(hour);
            env.gridPrice = gridPriceAt(hour);

            // ── Prepare neural inputs for all agents ──
            const aliveAgents = agents.filter(a => !a.dead);
            if (aliveAgents.length === 0) {
                if (state.frame < GRID_MAX_FRAMES) {
                    // All dead early → force evolution
                    runEvolution();
                }
                return;
            }

            const inputs = new Float32Array(GRID_POPULATION_SIZE * GRID_INPUTS);
            const hourRad = (2 * Math.PI * hour) / 24.0;

            for (let i = 0; i < GRID_POPULATION_SIZE; i++) {
                const agent = agents[i];
                const base = i * GRID_INPUTS;

                inputs[base + 0] = env.solarOutput / GRID_PEAK_SOLAR;      // Normalized solar
                inputs[base + 1] = env.houseDemand / 4.0;                   // Normalized demand (max ~4kW)
                inputs[base + 2] = agent.batterySoC;                         // Already 0..1
                inputs[base + 3] = env.gridPrice / 0.30;                     // Normalized by peak price
                inputs[base + 4] = Math.sin(hourRad);                        // Cyclic time
                inputs[base + 5] = Math.cos(hourRad);                        // Cyclic time
                inputs[base + 6] = priceTrend(hour);                         // Price trend
                inputs[base + 7] = solarForecast(hour, env.cloudCover);      // Solar forecast
            }

            // ── Forward pass ──
            const outputs = computeGrid(inputs);
            if (!outputs) return;

            // ── Apply actions ──
            const dt = 1 / 60; // 1 minute in hours

            let alive = 0;
            for (let i = 0; i < GRID_POPULATION_SIZE; i++) {
                const agent = agents[i];
                if (agent.dead) continue;

                const base = i * GRID_OUTPUTS;
                const chargeSignal = outputs[base + 0];
                const dischargeSignal = outputs[base + 1];
                const sellSignal = outputs[base + 2];

                // Determine action: argmax
                let action: 'charge' | 'discharge' | 'sell';
                if (chargeSignal >= dischargeSignal && chargeSignal >= sellSignal) {
                    action = 'charge';
                } else if (dischargeSignal >= chargeSignal && dischargeSignal >= sellSignal) {
                    action = 'discharge';
                } else {
                    action = 'sell';
                }

                const surplus = env.solarOutput - env.houseDemand; // kW (can be negative)

                if (action === 'charge') {
                    // Charge battery: use surplus solar first, then buy from grid
                    if (surplus > 0) {
                        // Free solar charging
                        const chargeAmount = Math.min(surplus * dt, (1 - agent.batterySoC) * GRID_BATTERY_CAPACITY);
                        agent.batterySoC += (chargeAmount * GRID_BATTERY_EFFICIENCY) / GRID_BATTERY_CAPACITY;
                    } else {
                        // Must buy from grid to charge AND power house
                        const deficit = -surplus;
                        agent.totalCost += deficit * dt * env.gridPrice;
                        // Also charge a bit from grid
                        const gridCharge = Math.min(1.0 * dt, (1 - agent.batterySoC) * GRID_BATTERY_CAPACITY);
                        agent.totalCost += gridCharge * env.gridPrice;
                        agent.batterySoC += (gridCharge * GRID_BATTERY_EFFICIENCY) / GRID_BATTERY_CAPACITY;
                    }
                } else if (action === 'discharge') {
                    // Use battery to cover demand
                    if (surplus < 0) {
                        const deficit = -surplus;
                        const discharge = Math.min(deficit * dt, agent.batterySoC * GRID_BATTERY_CAPACITY);
                        agent.batterySoC -= discharge / GRID_BATTERY_CAPACITY;
                        // Remaining deficit from grid
                        const remaining = deficit * dt - discharge;
                        if (remaining > 0) {
                            agent.totalCost += remaining * env.gridPrice;
                        }
                    }
                    // If surplus > 0 and discharging, just waste solar (bad decision — penalized by fitness)
                } else {
                    // Sell: if surplus solar, sell it; otherwise just buy deficit from grid
                    if (surplus > 0) {
                        agent.totalRevenue += surplus * dt * sellPriceAt(hour);
                    } else {
                        agent.totalCost += (-surplus) * dt * env.gridPrice;
                    }
                }

                // Clamp battery
                agent.batterySoC = Math.max(0, Math.min(1, agent.batterySoC));

                // Kill if battery is critically drained for too long (optional penalty)
                // We keep all agents alive for full 24h to get comparable fitness

                // Update fitness: lower cost is better, revenue is a bonus
                const netCost = agent.totalCost - agent.totalRevenue;
                const batteryBonus = agent.batterySoC * 0.5; // Reward ending with charge
                agent.fitness = Math.max(0, 10.0 - netCost + batteryBonus);

                alive++;
            }

            setStats(s => ({ ...s, alive }));

            // ── End of day → evolve ──
            if (state.frame >= GRID_MAX_FRAMES) {
                runEvolution();
            }
        } finally {
            isComputing.current = false;
        }
    }, [computeGrid, runEvolution, setStats]);

    return { gameState, resetGrid, updatePhysics };
}
