import { useEffect, useRef, useState, useCallback } from 'react';
import * as wasm from '../../wasm/pkg/gran_prix_wasm';

import {
    VACUUM_WIDTH,
    VACUUM_HEIGHT,
    VACUUM_SIZE,
    VACUUM_CELL_SIZE,
    VacuumStats,
} from '../../types';
import { PerformanceData, PerformanceCharts } from '../PerformanceCharts';
import { useVacuumWasm } from '../../hooks/useVacuumWasm';
import { useVacuumGameLoop } from '../../hooks/useVacuumGameLoop';

import { VacuumCanvas } from './VacuumCanvas';
import { VacuumStatsBar } from './VacuumStatsBar';
import { VacuumNetworkViz } from './VacuumNetworkViz';
import { GameControls } from '../GameControls';

const DEFAULT_MUTATION_RATE = 0.15;
const DEFAULT_MUTATION_SCALE = 0.5;

// ─── Drawing helpers ─────────────────────────────────────────────────────────

function drawFloor(ctx: CanvasRenderingContext2D) {
    // Room floor — warm wood-tone gradient
    const grad = ctx.createLinearGradient(0, 0, 0, VACUUM_HEIGHT);
    grad.addColorStop(0, '#2a2218');
    grad.addColorStop(1, '#1e1a14');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, VACUUM_WIDTH, VACUUM_HEIGHT);

    // Floor tile grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    for (let x = 0; x < VACUUM_WIDTH; x += VACUUM_CELL_SIZE) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, VACUUM_HEIGHT);
        ctx.stroke();
    }
    for (let y = 0; y < VACUUM_HEIGHT; y += VACUUM_CELL_SIZE) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(VACUUM_WIDTH, y);
        ctx.stroke();
    }

    // Room border (walls)
    ctx.strokeStyle = '#5a4a3a';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, VACUUM_WIDTH - 4, VACUUM_HEIGHT - 4);
}

function drawDust(
    ctx: CanvasRenderingContext2D,
    dustMap: boolean[],
    cols: number,
    rows: number,
) {
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            if (dustMap[row * cols + col]) {
                const x = col * VACUUM_CELL_SIZE;
                const y = row * VACUUM_CELL_SIZE;

                // Dust particle cluster
                ctx.fillStyle = 'rgba(180, 160, 130, 0.35)';
                ctx.beginPath();
                ctx.arc(
                    x + VACUUM_CELL_SIZE * 0.5,
                    y + VACUUM_CELL_SIZE * 0.5,
                    VACUUM_CELL_SIZE * 0.3,
                    0,
                    Math.PI * 2,
                );
                ctx.fill();

                // Additional small particles for texture
                ctx.fillStyle = 'rgba(160, 140, 110, 0.25)';
                ctx.beginPath();
                ctx.arc(
                    x + VACUUM_CELL_SIZE * 0.3,
                    y + VACUUM_CELL_SIZE * 0.35,
                    2,
                    0,
                    Math.PI * 2,
                );
                ctx.fill();
                ctx.beginPath();
                ctx.arc(
                    x + VACUUM_CELL_SIZE * 0.7,
                    y + VACUUM_CELL_SIZE * 0.65,
                    1.5,
                    0,
                    Math.PI * 2,
                );
                ctx.fill();
            }
        }
    }
}

function drawObstacles(
    ctx: CanvasRenderingContext2D,
    obstacles: { x: number; y: number; w: number; h: number; label: string }[],
) {
    for (const o of obstacles) {
        // Obstacle body (dark furniture)
        ctx.fillStyle = '#3a3028';
        ctx.fillRect(o.x, o.y, o.w, o.h);

        // Border
        ctx.strokeStyle = '#5a4a38';
        ctx.lineWidth = 2;
        ctx.strokeRect(o.x, o.y, o.w, o.h);

        // Inner detail line
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
        ctx.lineWidth = 1;
        ctx.strokeRect(o.x + 4, o.y + 4, o.w - 8, o.h - 8);

        // Label
        ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.font = 'bold 8px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(o.label, o.x + o.w / 2, o.y + o.h / 2);
    }
    ctx.textBaseline = 'alphabetic';
}

function drawCharger(ctx: CanvasRenderingContext2D, x: number, y: number, frame: number) {
    // Charger pad
    const pulseAlpha = 0.3 + Math.sin(frame * 0.08) * 0.15;

    // Glow
    const glowGrad = ctx.createRadialGradient(x, y, 0, x, y, 35);
    glowGrad.addColorStop(0, `rgba(16, 185, 129, ${pulseAlpha})`);
    glowGrad.addColorStop(1, 'rgba(16, 185, 129, 0)');
    ctx.fillStyle = glowGrad;
    ctx.beginPath();
    ctx.arc(x, y, 35, 0, Math.PI * 2);
    ctx.fill();

    // Base circle
    ctx.fillStyle = '#1a3a2a';
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.stroke();

    // Lightning bolt icon
    ctx.fillStyle = '#10b981';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⚡', x, y);
    ctx.textBaseline = 'alphabetic';

    // Label
    ctx.fillStyle = '#10b98188';
    ctx.font = 'bold 7px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('CHARGER', x, y + 28);
}

function drawVacuumAgent(
    ctx: CanvasRenderingContext2D,
    x: number, y: number,
    heading: number,
    battery: number,
    color: string,
    isTop: boolean,
    showSensors: boolean,
) {
    ctx.save();
    ctx.translate(x, y);

    // Body circle
    ctx.globalAlpha = isTop ? 0.9 : 0.5;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, VACUUM_SIZE, 0, Math.PI * 2);
    ctx.fill();

    // Heading indicator (triangle)
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = isTop ? 0.8 : 0.3;
    const tipX = Math.cos(heading) * VACUUM_SIZE;
    const tipY = Math.sin(heading) * VACUUM_SIZE;
    const leftX = Math.cos(heading + 2.5) * VACUUM_SIZE * 0.5;
    const leftY = Math.sin(heading + 2.5) * VACUUM_SIZE * 0.5;
    const rightX = Math.cos(heading - 2.5) * VACUUM_SIZE * 0.5;
    const rightY = Math.sin(heading - 2.5) * VACUUM_SIZE * 0.5;

    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(leftX, leftY);
    ctx.lineTo(rightX, rightY);
    ctx.closePath();
    ctx.fill();

    // Battery indicator (small bar below)
    if (isTop) {
        ctx.globalAlpha = 0.8;
        const barW = VACUUM_SIZE * 2;
        const barH = 3;
        const barX = -VACUUM_SIZE;
        const barY = VACUUM_SIZE + 4;

        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(barX, barY, barW, barH);

        const fillColor = battery > 0.5 ? '#10b981' : battery > 0.2 ? '#f59e0b' : '#ef4444';
        ctx.fillStyle = fillColor;
        ctx.fillRect(barX, barY, barW * battery, barH);
    }

    // Sensor rays (only for best agent)
    if (showSensors) {
        ctx.globalAlpha = 0.25;
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);

        const sensorLen = VACUUM_CELL_SIZE * 4;
        const angles = [heading, heading - Math.PI / 3, heading + Math.PI / 3];
        for (const angle of angles) {
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(Math.cos(angle) * sensorLen, Math.sin(angle) * sensorLen);
            ctx.stroke();
        }
        ctx.setLineDash([]);
    }

    ctx.restore();
    ctx.globalAlpha = 1.0;
}

function drawMiniDustMap(
    ctx: CanvasRenderingContext2D,
    dustMap: boolean[],
    cols: number,
    rows: number,
    mapX: number,
    mapY: number,
    mapW: number,
    mapH: number,
) {
    // Background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(mapX, mapY, mapW, mapH);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.strokeRect(mapX, mapY, mapW, mapH);

    // Title
    ctx.fillStyle = '#ffffff88';
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('DUST MAP', mapX + 4, mapY + 10);

    const cellW = (mapW - 8) / cols;
    const cellH = (mapH - 18) / rows;
    const startX = mapX + 4;
    const startY = mapY + 14;

    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            if (dustMap[row * cols + col]) {
                ctx.fillStyle = 'rgba(180, 140, 80, 0.6)';
            } else {
                ctx.fillStyle = 'rgba(16, 185, 129, 0.15)';
            }
            ctx.fillRect(
                startX + col * cellW,
                startY + row * cellH,
                cellW - 0.5,
                cellH - 0.5,
            );
        }
    }
}

function drawLegend(
    ctx: CanvasRenderingContext2D,
    x: number, y: number,
    w: number, h: number,
    bestAgent: { dustCleaned: number; battery: number; wallHits: number } | null,
    totalDust: number,
    frame: number,
    generation: number,
) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.strokeRect(x, y, w, h);

    ctx.font = '8px monospace';
    ctx.textAlign = 'left';

    ctx.fillStyle = '#ffffff88';
    ctx.fillText('BEST AGENT', x + 6, y + 12);

    if (bestAgent) {
        const pct = totalDust > 0 ? ((bestAgent.dustCleaned / totalDust) * 100).toFixed(1) : '0';
        ctx.fillStyle = '#10b981';
        ctx.fillText(`🧹 Cleaned: ${pct}%`, x + 6, y + 26);
        ctx.fillStyle = bestAgent.battery > 0.3 ? '#10b981' : '#ef4444';
        ctx.fillText(`🔋 Battery: ${(bestAgent.battery * 100).toFixed(0)}%`, x + 6, y + 40);
        ctx.fillStyle = '#f59e0b';
        ctx.fillText(`💥 Hits: ${bestAgent.wallHits}`, x + 6, y + 54);
    }

    ctx.fillStyle = '#ffffff55';
    ctx.fillText(`GEN ${generation} | F ${frame}/800`, x + 6, y + 70);
}

// ─── Main Component ────────────────────────────────────────────────────────────

export function VacuumDemo() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [stats, setStats] = useState<VacuumStats>({ generation: 1, best: 0, avgCleaned: 0, alive: 0 });
    const [performanceHistory, setPerformanceHistory] = useState<PerformanceData[]>([]);
    const [brainSnapshot, setBrainSnapshot] = useState<any>(null);

    const { population, initVacuumWasm, computeVacuum, evolveVacuum, getVacuumBestSnapshot } = useVacuumWasm();

    const evolve = useCallback((
        fitnessScores: number[],
        rate: number,
        scale: number,
        strategy: wasm.MutationStrategy,
    ) => {
        evolveVacuum(fitnessScores, rate, scale, strategy);
    }, [evolveVacuum]);

    const onGenerationEnd = useCallback((maxFitness: number, avgFitness: number) => {
        setPerformanceHistory(prev => {
            const nextGen = prev.length > 0 ? prev[prev.length - 1].generation + 1 : 1;
            const newHistory = [...prev, { generation: nextGen, avg: avgFitness, max: maxFitness }];
            return newHistory.slice(-50);
        });
    }, []);

    const { gameState, resetVacuum, updatePhysics } = useVacuumGameLoop({
        computeVacuum,
        evolve,
        setStats,
        mutationRate: DEFAULT_MUTATION_RATE,
        mutationScale: DEFAULT_MUTATION_SCALE,
        mutationStrategy: wasm.MutationStrategy.Additive,
        onGenerationEnd,
    });

    // Init WASM
    useEffect(() => {
        if (!population) {
            initVacuumWasm().then(() => {
                resetVacuum();
            });
        }
    }, [initVacuumWasm, population, resetVacuum]);

    // Update brain snapshot periodically
    useEffect(() => {
        if (!isPlaying) return;
        const interval = setInterval(() => {
            const state = gameState.current;
            const fitnessArr = Float32Array.from(state.agents.map(a => a.fitness));
            const snap = getVacuumBestSnapshot(fitnessArr);
            setBrainSnapshot(snap);
        }, 2000);
        return () => clearInterval(interval);
    }, [isPlaying, getVacuumBestSnapshot, gameState]);

    // Render
    const render = useCallback((ctx: CanvasRenderingContext2D) => {
        const state = gameState.current;
        const { env, agents, frame } = state;

        // Floor & tile grid
        drawFloor(ctx);

        // Dust particles
        drawDust(ctx, env.dustMap, env.cols, env.rows);

        // Obstacles (furniture)
        drawObstacles(ctx, env.obstacles);

        // Charger station
        drawCharger(ctx, env.chargerX, env.chargerY, frame);

        // Draw vacuum agents (top 10 by fitness, best on top)
        const sorted = [...agents].filter(a => !a.dead).sort((a, b) => b.fitness - a.fitness);
        const topAgents = sorted.slice(0, 10);

        // Draw non-top agents faintly
        for (const agent of sorted.slice(10)) {
            drawVacuumAgent(ctx, agent.x, agent.y, agent.heading, agent.battery, agent.color, false, false);
        }

        // Draw top agents
        for (let i = topAgents.length - 1; i >= 0; i--) {
            const agent = topAgents[i];
            drawVacuumAgent(ctx, agent.x, agent.y, agent.heading, agent.battery, agent.color, true, i === 0);
        }

        // Draw dead agents as gray dots
        for (const agent of agents.filter(a => a.dead)) {
            ctx.globalAlpha = 0.15;
            ctx.fillStyle = '#666';
            ctx.beginPath();
            ctx.arc(agent.x, agent.y, VACUUM_SIZE * 0.5, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1.0;

        // Mini dust map (top-right)
        drawMiniDustMap(ctx, env.dustMap, env.cols, env.rows, VACUUM_WIDTH - 180, 10, 170, 130);

        // Legend (bottom-right)
        const bestAgent = topAgents[0] || null;
        drawLegend(
            ctx,
            VACUUM_WIDTH - 180, VACUUM_HEIGHT - 90,
            170, 82,
            bestAgent,
            env.totalDust,
            frame,
            state.generation,
        );
    }, [gameState]);

    // Game loop
    const rafId = useRef<number | null>(null);
    const isLoopActive = useRef(false);

    const gameLoop = useCallback(() => {
        if (!isPlaying) {
            isLoopActive.current = false;
            return;
        }
        if (!canvasRef.current) {
            rafId.current = requestAnimationFrame(gameLoop);
            return;
        }

        const ctx = canvasRef.current.getContext('2d');
        if (!ctx) return;

        // Run multiple physics ticks per frame for speed
        for (let i = 0; i < 3; i++) {
            updatePhysics();
        }

        render(ctx);
        rafId.current = requestAnimationFrame(gameLoop);
    }, [isPlaying, updatePhysics, render]);

    useEffect(() => {
        if (isPlaying && !isLoopActive.current) {
            isLoopActive.current = true;
            rafId.current = requestAnimationFrame(gameLoop);
        }
        return () => {
            if (rafId.current) cancelAnimationFrame(rafId.current);
            isLoopActive.current = false;
        };
    }, [isPlaying, gameLoop]);

    // Compute dust progress for stats bar
    const currentDustRemaining = gameState.current.env.dustMap.filter(d => d).length;
    const totalDust = gameState.current.env.totalDust;
    const dustProgress = totalDust > 0 ? 1 - (currentDustRemaining / totalDust) : 0;

    const bestBattery = gameState.current.agents
        .filter(a => !a.dead)
        .sort((a, b) => b.fitness - a.fitness)[0]?.battery ?? 0;

    return (
        <div className="flex flex-col items-center gap-6 w-full max-w-5xl">
            <VacuumStatsBar
                stats={stats}
                battery={bestBattery}
                dustProgress={dustProgress}
                frame={gameState.current.frame}
            />

            <VacuumCanvas ref={canvasRef} />

            <GameControls
                isPlaying={isPlaying}
                onTogglePlay={() => setIsPlaying(!isPlaying)}
                onReset={() => {
                    resetVacuum();
                    setStats({ generation: 1, best: 0, avgCleaned: 0, alive: 0 });
                    setPerformanceHistory([]);
                }}
                isRestarting={false}
            />

            <div className="w-full flex flex-col lg:flex-row gap-6">
                <div className="flex-1">
                    <PerformanceCharts data={performanceHistory} />
                </div>
                <div className="w-full lg:w-80">
                    <VacuumNetworkViz snapshot={brainSnapshot} />
                </div>
            </div>
        </div>
    );
}
