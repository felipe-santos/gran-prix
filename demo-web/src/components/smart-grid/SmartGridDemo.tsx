import { useEffect, useRef, useState, useCallback } from 'react';
import * as wasm from '../../wasm/pkg/gran_prix_wasm';

import {
    GRID_WIDTH,
    GRID_HEIGHT,
    GRID_PEAK_SOLAR,
    GridStats,
} from '../../types';
import { PerformanceData, PerformanceCharts } from '../PerformanceCharts';
import { useSmartGridWasm } from '../../hooks/useSmartGridWasm';
import { useSmartGridGameLoop } from '../../hooks/useSmartGridGameLoop';

import { SmartGridCanvas } from './SmartGridCanvas';
import { SmartGridStatsBar } from './SmartGridStatsBar';
import { SmartGridNetworkViz } from './SmartGridNetworkViz';
import { GameControls } from '../GameControls';

const DEFAULT_MUTATION_RATE = 0.15;
const DEFAULT_MUTATION_SCALE = 0.5;

// ─── Drawing helpers ─────────────────────────────────────────────────────────

function drawSky(ctx: CanvasRenderingContext2D, hour: number, cloudCover: number) {
    // Sky gradient based on time of day
    let skyTop: string, skyBottom: string;

    if (hour < 5 || hour > 21) {
        skyTop = '#0a0a1a';
        skyBottom = '#141428';
    } else if (hour < 7) {
        const f = (hour - 5) / 2;
        skyTop = lerpColor('#0a0a1a', '#1e3a5f', f);
        skyBottom = lerpColor('#141428', '#ff7043', f);
    } else if (hour < 10) {
        const f = (hour - 7) / 3;
        skyTop = lerpColor('#1e3a5f', '#4fc3f7', f);
        skyBottom = lerpColor('#ff7043', '#81d4fa', f);
    } else if (hour < 17) {
        skyTop = '#4fc3f7';
        skyBottom = '#b3e5fc';
    } else if (hour < 20) {
        const f = (hour - 17) / 3;
        skyTop = lerpColor('#4fc3f7', '#1e3a5f', f);
        skyBottom = lerpColor('#b3e5fc', '#ff7043', f);
    } else {
        const f = (hour - 20) / 1;
        skyTop = lerpColor('#1e3a5f', '#0a0a1a', f);
        skyBottom = lerpColor('#ff7043', '#141428', f);
    }

    const grad = ctx.createLinearGradient(0, 0, 0, GRID_HEIGHT * 0.6);
    grad.addColorStop(0, skyTop);
    grad.addColorStop(1, skyBottom);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, GRID_WIDTH, GRID_HEIGHT * 0.6);

    // Ground
    ctx.fillStyle = '#1a2a1a';
    ctx.fillRect(0, GRID_HEIGHT * 0.6, GRID_WIDTH, GRID_HEIGHT * 0.4);

    // Grass line
    ctx.strokeStyle = '#2d5a2d';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, GRID_HEIGHT * 0.6);
    ctx.lineTo(GRID_WIDTH, GRID_HEIGHT * 0.6);
    ctx.stroke();

    // Sun / Moon
    if (hour >= 5.5 && hour <= 20) {
        const sunProgress = (hour - 5.5) / 14.5;
        const sunX = sunProgress * GRID_WIDTH;
        const sunY = GRID_HEIGHT * 0.5 - Math.sin(sunProgress * Math.PI) * GRID_HEIGHT * 0.4;

        // Sun glow
        const glowGrad = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, 60);
        glowGrad.addColorStop(0, 'rgba(255, 200, 50, 0.4)');
        glowGrad.addColorStop(1, 'rgba(255, 200, 50, 0)');
        ctx.fillStyle = glowGrad;
        ctx.beginPath();
        ctx.arc(sunX, sunY, 60, 0, Math.PI * 2);
        ctx.fill();

        // Sun disc
        ctx.fillStyle = '#ffd54f';
        ctx.beginPath();
        ctx.arc(sunX, sunY, 18, 0, Math.PI * 2);
        ctx.fill();
    } else {
        // Moon
        const moonX = GRID_WIDTH * 0.8;
        const moonY = GRID_HEIGHT * 0.15;
        ctx.fillStyle = 'rgba(200, 200, 230, 0.8)';
        ctx.beginPath();
        ctx.arc(moonX, moonY, 12, 0, Math.PI * 2);
        ctx.fill();
    }

    // Clouds
    if (cloudCover > 0.1) {
        const numClouds = Math.floor(cloudCover * 6);
        ctx.fillStyle = `rgba(200, 210, 220, ${cloudCover * 0.6})`;
        for (let c = 0; c < numClouds; c++) {
            const cx = ((c * 173 + 50) % GRID_WIDTH);
            const cy = 40 + (c * 57 % 80);
            drawCloud(ctx, cx, cy, 30 + c * 10);
        }
    }
}

function drawCloud(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
    ctx.beginPath();
    ctx.arc(x, y, size * 0.4, 0, Math.PI * 2);
    ctx.arc(x + size * 0.3, y - size * 0.15, size * 0.3, 0, Math.PI * 2);
    ctx.arc(x + size * 0.6, y, size * 0.35, 0, Math.PI * 2);
    ctx.fill();
}

function drawHouse(ctx: CanvasRenderingContext2D, x: number, y: number, batteryPct: number, isActive: boolean) {
    const w = 60, h = 45;

    // House body
    ctx.fillStyle = isActive ? '#3a5a3a' : '#2a3a2a';
    ctx.fillRect(x, y, w, h);

    // Roof
    ctx.fillStyle = isActive ? '#5a7a5a' : '#3a4a3a';
    ctx.beginPath();
    ctx.moveTo(x - 5, y);
    ctx.lineTo(x + w / 2, y - 25);
    ctx.lineTo(x + w + 5, y);
    ctx.closePath();
    ctx.fill();

    // Solar panel on roof
    ctx.fillStyle = '#1a3a6a';
    ctx.fillRect(x + 10, y - 18, 20, 10);
    ctx.fillRect(x + 32, y - 15, 18, 8);

    // Window (lit at night)
    ctx.fillStyle = '#ffd54f66';
    ctx.fillRect(x + 12, y + 10, 12, 12);
    ctx.fillRect(x + 36, y + 10, 12, 12);

    // Door
    ctx.fillStyle = '#4a3a2a';
    ctx.fillRect(x + 24, y + 20, 12, 25);

    // Battery indicator bar below house
    const barW = w;
    const barH = 6;
    const barY = y + h + 4;

    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(x, barY, barW, barH);

    // Battery fill
    const fillColor = batteryPct > 0.5 ? '#10b981' : batteryPct > 0.2 ? '#f59e0b' : '#ef4444';
    ctx.fillStyle = fillColor;
    ctx.fillRect(x, barY, barW * batteryPct, barH);

    // Battery label
    ctx.fillStyle = '#ffffff88';
    ctx.font = '7px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${(batteryPct * 100).toFixed(0)}%`, x + w / 2, barY + barH + 10);
}

function drawEnergyFlowArrow(
    ctx: CanvasRenderingContext2D,
    fromX: number, fromY: number,
    toX: number, toY: number,
    color: string,
    frame: number,
) {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 5) return;

    const nx = dx / len;
    const ny = dy / len;

    // Animated dash
    ctx.setLineDash([6, 6]);
    ctx.lineDashOffset = -(frame * 2) % 12;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    ctx.stroke();

    // Arrowhead
    const headLen = 8;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(toX - headLen * nx + headLen * 0.4 * ny, toY - headLen * ny - headLen * 0.4 * nx);
    ctx.lineTo(toX - headLen * nx - headLen * 0.4 * ny, toY - headLen * ny + headLen * 0.4 * nx);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    ctx.globalAlpha = 1.0;
}

function drawPriceGraph(ctx: CanvasRenderingContext2D, hour: number, x: number, y: number, w: number, h: number) {
    // Background
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.strokeRect(x, y, w, h);

    // Title
    ctx.fillStyle = '#ffffff88';
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('Price $/kWh', x + 4, y + 10);

    // Price curve
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    for (let i = 0; i <= 24; i++) {
        const px = x + (i / 24) * w;
        const price = getPriceAt(i);
        const py = y + h - (price / 0.35) * (h - 16);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Current time indicator
    const cx = x + (hour / 24) * w;
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, y);
    ctx.lineTo(cx, y + h);
    ctx.stroke();
    ctx.setLineDash([]);
}

function drawSolarGraph(ctx: CanvasRenderingContext2D, hour: number, cloudCover: number, x: number, y: number, w: number, h: number) {
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.strokeRect(x, y, w, h);

    ctx.fillStyle = '#ffffff88';
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('Solar kW', x + 4, y + 10);

    ctx.strokeStyle = '#ffd54f';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i <= 24; i++) {
        const px = x + (i / 24) * w;
        const solar = getSolarAt(i, cloudCover);
        const py = y + h - (solar / 7) * (h - 16);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
    }
    ctx.stroke();

    const cx = x + (hour / 24) * w;
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, y);
    ctx.lineTo(cx, y + h);
    ctx.stroke();
    ctx.setLineDash([]);
}

// Simplified copies of the environment functions (for graph drawing only)
function getPriceAt(hour: number): number {
    if (hour < 6 || hour >= 22) return 0.08;
    if (hour >= 6 && hour < 10) return 0.15;
    if (hour >= 10 && hour < 17) return 0.12;
    if (hour >= 17 && hour < 21) return 0.30;
    return 0.15;
}

function getSolarAt(hour: number, cloud: number): number {
    if (hour < 5.5 || hour > 19.5) return 0;
    return Math.max(0, Math.sin(Math.PI * (hour - 5.5) / 14.0) * GRID_PEAK_SOLAR * (1 - cloud * 0.75));
}

function lerpColor(a: string, b: string, t: number): string {
    const pa = parseHex(a);
    const pb = parseHex(b);
    const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
    const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
    const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
    return `rgb(${r},${g},${bl})`;
}

function parseHex(hex: string): [number, number, number] {
    hex = hex.replace('#', '');
    return [
        parseInt(hex.substring(0, 2), 16),
        parseInt(hex.substring(2, 4), 16),
        parseInt(hex.substring(4, 6), 16),
    ];
}

// ─── Grid label on power line ──────────────────────────────────────────────────

function drawPowerLine(ctx: CanvasRenderingContext2D, x: number, y: number) {
    // Utility pole
    ctx.strokeStyle = '#5a4a3a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, y + 60);
    ctx.lineTo(x, y);
    ctx.stroke();

    // Cross beam
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 15, y + 5);
    ctx.lineTo(x + 15, y + 5);
    ctx.stroke();

    // Wires
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(x + i * 12, y + 5);
        ctx.quadraticCurveTo(x + i * 12 + 30, y + 20, x + i * 12 + 60, y + 5);
        ctx.stroke();
    }

    // Label
    ctx.fillStyle = '#ffffff88';
    ctx.font = 'bold 8px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('GRID', x, y + 72);
}

// ─── Main Component ────────────────────────────────────────────────────────────

export function SmartGridDemo() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [stats, setStats] = useState<GridStats>({ generation: 1, best: 0, avgCost: 0, avgFitness: 0 });
    const [performanceHistory, setPerformanceHistory] = useState<PerformanceData[]>([]);

    const { population, initGridWasm, computeGrid, evolveGrid } = useSmartGridWasm();

    const evolve = useCallback((
        fitnessScores: number[],
        rate: number,
        scale: number,
        strategy: wasm.MutationStrategy,
    ) => {
        evolveGrid(fitnessScores, rate, scale, strategy);
    }, [evolveGrid]);

    const onGenerationEnd = useCallback((maxFitness: number, avgFitness: number) => {
        setPerformanceHistory(prev => {
            const nextGen = prev.length > 0 ? prev[prev.length - 1].generation + 1 : 1;
            const newHistory = [...prev, { generation: nextGen, avg: avgFitness, max: maxFitness }];
            return newHistory.slice(-50);
        });
    }, []);

    const { gameState, resetGrid, updatePhysics } = useSmartGridGameLoop({
        computeGrid,
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
            initGridWasm().then(() => {
                resetGrid();
            });
        }
    }, [initGridWasm, population, resetGrid]);


    // Render
    const render = useCallback((ctx: CanvasRenderingContext2D) => {
        const state = gameState.current;
        const { env, agents, frame } = state;

        // Sky & scenery
        drawSky(ctx, env.hour, env.cloudCover);

        // Power line (right side)
        drawPowerLine(ctx, GRID_WIDTH - 80, GRID_HEIGHT * 0.35);

        // Draw houses (top 5 agents by fitness)
        const sorted = [...agents].sort((a, b) => b.fitness - a.fitness);
        const topAgents = sorted.slice(0, 5);
        const houseY = GRID_HEIGHT * 0.58;

        topAgents.forEach((agent, i) => {
            const houseX = 80 + i * 150;
            drawHouse(ctx, houseX, houseY, agent.batterySoC, !agent.dead);

            // Energy flow arrows
            const houseCenterX = houseX + 30;
            const houseCenterY = houseY + 20;

            // Solar → House (yellow)
            if (env.solarOutput > 0.1) {
                drawEnergyFlowArrow(ctx, houseX + 20, houseY - 20, houseCenterX, houseCenterY, '#ffd54f', frame);
            }

            // Grid → House (red/orange when buying)
            if (agent.totalCost > 0 && frame % 3 === 0) {
                drawEnergyFlowArrow(ctx, GRID_WIDTH - 80, GRID_HEIGHT * 0.45, houseCenterX, houseCenterY, '#ef4444', frame);
            }

            // House → Grid (green when selling)
            if (agent.totalRevenue > 0 && env.solarOutput > 2) {
                drawEnergyFlowArrow(ctx, houseCenterX, houseCenterY, GRID_WIDTH - 80, GRID_HEIGHT * 0.45, '#10b981', frame);
            }
        });

        // Mini graphs (bottom area)
        drawPriceGraph(ctx, env.hour, 20, GRID_HEIGHT - 110, 200, 90);
        drawSolarGraph(ctx, env.hour, env.cloudCover, 240, GRID_HEIGHT - 110, 200, 90);

        // Legend
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(460, GRID_HEIGHT - 110, 180, 90);
        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.strokeRect(460, GRID_HEIGHT - 110, 180, 90);

        ctx.font = '8px monospace';
        ctx.textAlign = 'left';
        ctx.fillStyle = '#ffffff88';
        ctx.fillText('LIVE METRICS', 470, GRID_HEIGHT - 95);

        ctx.fillStyle = '#ffd54f';
        ctx.fillText(`☀ Solar: ${env.solarOutput.toFixed(1)} kW`, 470, GRID_HEIGHT - 80);
        ctx.fillStyle = '#81d4fa';
        ctx.fillText(`🏠 Demand: ${env.houseDemand.toFixed(1)} kW`, 470, GRID_HEIGHT - 66);
        ctx.fillStyle = '#f59e0b';
        ctx.fillText(`💰 Price: $${env.gridPrice.toFixed(2)}/kWh`, 470, GRID_HEIGHT - 52);
        ctx.fillStyle = '#10b981';
        ctx.fillText(`🔋 Best SoC: ${(topAgents[0]?.batterySoC * 100 || 0).toFixed(0)}%`, 470, GRID_HEIGHT - 38);
        ctx.fillStyle = '#ef4444';
        ctx.fillText(`💸 Best Cost: $${(topAgents[0]?.totalCost || 0).toFixed(2)}`, 470, GRID_HEIGHT - 24);

        // Frame / generation HUD
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(GRID_WIDTH - 170, GRID_HEIGHT - 110, 150, 35);
        ctx.fillStyle = '#ffffff88';
        ctx.font = 'bold 9px monospace';
        ctx.textAlign = 'right';
        ctx.fillText(`GEN ${state.generation} | FRAME ${frame}/1440`, GRID_WIDTH - 30, GRID_HEIGHT - 92);
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

        // Run multiple physics ticks per frame for speed (24h in ~24 seconds)
        for (let i = 0; i < 4; i++) {
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

    return (
        <div className="flex flex-col items-center gap-6 w-full max-w-5xl">
            <SmartGridStatsBar
                stats={stats}
                solarOutput={gameState.current.env.solarOutput}
                batterySoC={gameState.current.agents[0]?.batterySoC ?? 0.5}
                gridPrice={gameState.current.env.gridPrice}
                hour={gameState.current.env.hour}
            />

            <SmartGridCanvas ref={canvasRef} />

            <GameControls
                isPlaying={isPlaying}
                onTogglePlay={() => setIsPlaying(!isPlaying)}
                onReset={() => {
                    resetGrid();
                    setStats({ generation: 1, best: 0, avgCost: 0, avgFitness: 0 });
                    setPerformanceHistory([]);
                }}
                isRestarting={false}
            />

            <div className="w-full flex flex-col lg:flex-row gap-6">
                <div className="flex-1">
                    <PerformanceCharts data={performanceHistory} />
                </div>
                <div className="w-full lg:w-80">
                    <SmartGridNetworkViz 
                        population={population} 
                        fitnessScores={Float32Array.from(gameState.current.agents.map(a => a.fitness))} 
                    />
                </div>
            </div>
        </div>
    );
}
