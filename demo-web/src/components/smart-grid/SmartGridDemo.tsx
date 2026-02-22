import { useEffect, useRef, useState, useCallback } from 'react';

import {
    GRID_WIDTH,
    GRID_HEIGHT,
    GridStats,
} from '../../types';
import { PerformanceCharts } from '../PerformanceCharts';
import { useSimulation } from '../../hooks/useSimulation';
import { smartGridSimulationConfig, GridSimulationState, GridAgent } from '../../demos/smart-grid/smartGridSimulation';

import { SmartGridCanvas } from './SmartGridCanvas';
import { SmartGridStatsBar } from './SmartGridStatsBar';
import { SmartGridNetworkViz } from './SmartGridNetworkViz';
import { GameControls } from '../GameControls';

// ─── Drawing helpers ─────────────────────────────────────────────────────────

function drawSky(ctx: CanvasRenderingContext2D, hour: number) {
    let skyTop: string, skyBottom: string;
    if (hour < 5 || hour > 21) { skyTop = '#0a0a1a'; skyBottom = '#141428'; }
    else if (hour < 7) { const f = (hour - 5) / 2; skyTop = lerpColor('#0a0a1a', '#1e3a5f', f); skyBottom = lerpColor('#141428', '#ff7043', f); }
    else if (hour < 10) { const f = (hour - 7) / 3; skyTop = lerpColor('#1e3a5f', '#4fc3f7', f); skyBottom = lerpColor('#ff7043', '#81d4fa', f); }
    else if (hour < 17) { skyTop = '#4fc3f7'; skyBottom = '#b3e5fc'; }
    else if (hour < 20) { const f = (hour - 17) / 3; skyTop = lerpColor('#4fc3f7', '#1e3a5f', f); skyBottom = lerpColor('#b3e5fc', '#ff7043', f); }
    else { const f = (hour - 20) / 1; skyTop = lerpColor('#1e3a5f', '#0a0a1a', f); skyBottom = lerpColor('#ff7043', '#141428', f); }

    const grad = ctx.createLinearGradient(0, 0, 0, GRID_HEIGHT * 0.6);
    grad.addColorStop(0, skyTop); grad.addColorStop(1, skyBottom);
    ctx.fillStyle = grad; ctx.fillRect(0, 0, GRID_WIDTH, GRID_HEIGHT * 0.6);
    ctx.fillStyle = '#1a2a1a'; ctx.fillRect(0, GRID_HEIGHT * 0.6, GRID_WIDTH, GRID_HEIGHT * 0.4);
    ctx.strokeStyle = '#2d5a2d'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, GRID_HEIGHT * 0.6); ctx.lineTo(GRID_WIDTH, GRID_HEIGHT * 0.6); ctx.stroke();

    if (hour >= 5.5 && hour <= 20) {
        const sunProgress = (hour - 5.5) / 14.5;
        const sunX = sunProgress * GRID_WIDTH;
        const sunY = GRID_HEIGHT * 0.5 - Math.sin(sunProgress * Math.PI) * GRID_HEIGHT * 0.4;
        const glowGrad = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, 60);
        glowGrad.addColorStop(0, 'rgba(255, 200, 50, 0.4)'); glowGrad.addColorStop(1, 'rgba(255, 200, 50, 0)');
        ctx.fillStyle = glowGrad; ctx.beginPath(); ctx.arc(sunX, sunY, 60, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffd54f'; ctx.beginPath(); ctx.arc(sunX, sunY, 18, 0, Math.PI * 2); ctx.fill();
    } else {
        const moonX = GRID_WIDTH * 0.8; const moonY = GRID_HEIGHT * 0.15;
        ctx.fillStyle = 'rgba(200, 200, 230, 0.8)'; ctx.beginPath(); ctx.arc(moonX, moonY, 12, 0, Math.PI * 2); ctx.fill();
    }
}

function lerpColor(a: string, b: string, f: number) {
    const ah = parseInt(a.replace('#', ''), 16),
        ar = ah >> 16, ag = (ah >> 8) & 0xff, ab = ah & 0xff;
    const bh = parseInt(b.replace('#', ''), 16),
        br = bh >> 16, bg = (bh >> 8) & 0xff, bb = bh & 0xff;
    const rr = ar + f * (br - ar),
        rg = ag + f * (bg - ag),
        rb = ab + f * (bb - ab);
    return `#${((1 << 24) + (Math.round(rr) << 16) + (Math.round(rg) << 8) + Math.round(rb)).toString(16).slice(1)}`;
}

function drawHouse(ctx: CanvasRenderingContext2D, x: number, y: number, demand: number) {
    const w = 120, h = 80;
    ctx.fillStyle = '#455a64'; ctx.fillRect(x - w / 2, y - h, w, h);
    ctx.fillStyle = '#263238'; ctx.beginPath(); ctx.moveTo(x - w / 2 - 10, y - h); ctx.lineTo(x, y - h - 40); ctx.lineTo(x + w / 2 + 10, y - h); ctx.closePath(); ctx.fill();
    ctx.fillStyle = demand > 2 ? '#fff59d' : '#37474f'; ctx.fillRect(x - 30, y - 50, 20, 20); ctx.fillRect(x + 10, y - 50, 20, 20);
    ctx.fillStyle = '#5d4037'; ctx.fillRect(x - 15, y - 40, 30, 40);
}

function drawBattery(ctx: CanvasRenderingContext2D, x: number, y: number, soc: number) {
    const w = 40, h = 70;
    ctx.strokeStyle = '#90a4ae'; ctx.lineWidth = 2; ctx.strokeRect(x - w / 2, y - h, w, h);
    ctx.fillStyle = '#90a4ae'; ctx.fillRect(x - 10, y - h - 5, 20, 5);
    const fillH = (h - 4) * soc;
    const color = soc < 0.2 ? '#ef5350' : soc < 0.5 ? '#ffca28' : '#66bb6a';
    ctx.fillStyle = color; ctx.fillRect(x - w / 2 + 2, y - fillH - 2, w - 4, fillH);
    ctx.fillStyle = 'white'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(`${(soc * 100).toFixed(0)}%`, x, y - h / 2 + 5);
}

function drawSolarPanels(ctx: CanvasRenderingContext2D, x: number, y: number, output: number) {
    const w = 100, h = 40;
    ctx.fillStyle = '#1a237e'; ctx.fillRect(x - w / 2, y - h, w, h);
    ctx.strokeStyle = '#3949ab'; ctx.lineWidth = 1;
    for (let j = 1; j < 4; j++) { ctx.beginPath(); ctx.moveTo(x - w / 2, y - h + (h / 4) * j); ctx.lineTo(x + w / 2, y - h + (h / 4) * j); ctx.stroke(); }
    for (let j = 1; j < 8; j++) { ctx.beginPath(); ctx.moveTo(x - w / 2 + (w / 8) * j, y - h); ctx.lineTo(x - w / 2 + (w / 8) * j, y); ctx.stroke(); }
    if (output > 0) {
        ctx.shadowBlur = 10; ctx.shadowColor = '#fff59d'; ctx.strokeStyle = '#fff59d'; ctx.lineWidth = 2; ctx.strokeRect(x - w / 2, y - h, w, h); ctx.shadowBlur = 0;
    }
}

function drawFlow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, value: number, color: string, time: number) {
    if (Math.abs(value) < 0.05) return;
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash([5, 5]); ctx.lineDashOffset = -time * 50;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = color; ctx.font = 'bold 10px sans-serif'; ctx.fillText(`${value.toFixed(1)}kW`, (x1 + x2) / 2, (y1 + y2) / 2 - 10);
}

export function SmartGridDemo() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rafRef = useRef<number | null>(null);
    const isLoopActive = useRef(false);

    const [isPlaying, setIsPlaying] = useState(false);
    
    // Unified Simulation Engine
    const { internalState, stats, performanceHistory, isReady, update, reset, engine } = useSimulation<GridAgent, GridSimulationState, GridStats>(smartGridSimulationConfig);

    const handleReset = useCallback(() => {
        setIsPlaying(false);
        reset();
    }, [reset]);

    const render = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const state = internalState.current;
        if (!state) return;
        const { env, agents, frame } = state;
        const bestAgent = [...agents].sort((a, b) => b.fitness - a.fitness)[0];

        ctx.clearRect(0, 0, GRID_WIDTH, GRID_HEIGHT);
        drawSky(ctx, env.hour);

        const hX = GRID_WIDTH / 2, hY = GRID_HEIGHT * 0.85;
        const sX = GRID_WIDTH * 0.2, sY = GRID_HEIGHT * 0.85;
        const bX = GRID_WIDTH * 0.8, bY = GRID_HEIGHT * 0.85;
        const gX = GRID_WIDTH / 2, gY = GRID_HEIGHT * 0.4;

        drawHouse(ctx, hX, hY, env.houseDemand);
        drawSolarPanels(ctx, sX, sY, env.solarOutput);
        drawBattery(ctx, bX, bY, bestAgent?.batterySoC || 0);

        if (bestAgent) {
            const time = frame / 60;
            drawFlow(ctx, sX, sY - 20, hX - 40, hY - 40, env.solarOutput, '#ffd54f', time);
            const netGrid = env.houseDemand - env.solarOutput;
            if (netGrid > 0) drawFlow(ctx, gX, gY, hX, hY - 60, netGrid, '#ef5350', time);
            else drawFlow(ctx, hX, hY - 60, gX, gY, -netGrid, '#66bb6a', time);
        }

        ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(10, 10, 180, 100); ctx.fillStyle = 'white'; ctx.font = '12px monospace';
        ctx.fillText(`TIME: ${Math.floor(env.hour).toString().padStart(2, '0')}:${Math.floor((env.hour % 1) * 60).toString().padStart(2, '0')}`, 20, 30);
        ctx.fillText(`SOLAR: ${env.solarOutput.toFixed(2)} kW`, 20, 50);
        ctx.fillText(`DEMAND: ${env.houseDemand.toFixed(2)} kW`, 20, 70);
        ctx.fillText(`PRICE: $${env.gridPrice.toFixed(2)}/kWh`, 20, 90);
    }, [internalState]);

    const gameLoop = useCallback(() => {
        if (!isPlaying || !isReady) {
            isLoopActive.current = false;
            return;
        }
        update();
        render();
        rafRef.current = requestAnimationFrame(gameLoop);
    }, [isPlaying, update, render, isReady]);

    useEffect(() => {
        if (isPlaying && !isLoopActive.current && isReady) {
            isLoopActive.current = true;
            rafRef.current = requestAnimationFrame(gameLoop);
        }
        return () => {
            if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
            isLoopActive.current = false;
        };
    }, [isPlaying, gameLoop, isReady]);

    if (!isReady || !stats || !internalState.current) {
        return (
            <div className="w-full flex flex-col items-center justify-center py-24 gap-4">
                <div className="w-12 h-12 border-4 border-yellow-500/20 border-t-yellow-500 rounded-full animate-spin" />
                <span className="text-[10px] uppercase font-black tracking-[0.3em] text-yellow-600">
                    Initializing Grid WASM…
                </span>
            </div>
        );
    }

    const state = internalState.current!;
    const bestAgent = [...state.agents].sort((a, b) => b.fitness - a.fitness)[0];

    return (
        <div className="w-full flex flex-col items-center gap-0">
            <div className="flex flex-col items-center mb-8">
                <h2 className="text-2xl font-black bg-gradient-to-br from-yellow-400 to-orange-600 bg-clip-text text-transparent uppercase tracking-[0.3em]">
                    Smart Grid Node
                </h2>
                <p className="text-[9px] text-muted-foreground uppercase tracking-[0.3em] mt-2 font-bold">
                    Energy Arbitrage · Demand Response
                </p>
            </div>

            <div className="w-full max-w-7xl flex flex-col lg:flex-row items-center lg:items-start justify-center gap-8">
                <div className="flex flex-col gap-6 flex-shrink-0 w-80">
                    <div className="bg-card/50 border border-border rounded-2xl overflow-hidden backdrop-blur-md p-6">
                        <div className="border-b border-border pb-3 mb-5">
                            <h3 className="text-sm font-bold text-foreground uppercase tracking-tighter">
                                Neural Brain
                            </h3>
                            <p className="text-[9px] text-muted-foreground font-mono mt-0.5">
                                BEST_AGENT_LIVE_WEIGHTS
                            </p>
                        </div>
                        <SmartGridNetworkViz
                            population={(engine as any)?.populations.get('grid')}
                            fitnessScores={engine?.fitnessScores.get('grid')}
                        />
                        <div className="mt-5 space-y-1.5 border-t border-border pt-4">
                            <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
                                Inputs (8)
                            </p>
                            {[
                                ['I₁', 'solar', 'Current Solar Output'],
                                ['I₂', 'demand', 'House Load'],
                                ['I₃', 'soc', 'Battery Charge %'],
                                ['I₄', 'price', 'Grid Electricity Price'],
                                ['I₅₋₆', 'time', 'Time of Day (sin/cos)'],
                                ['I₇', 'trend', 'Price Forecast Trend'],
                                ['I₈', 'forecast', 'Solar Forecast'],
                            ].map(([idx, name, desc]) => (
                                <div key={idx} className="flex items-start gap-2">
                                    <span className="text-[8px] font-mono text-yellow-500 w-5 flex-shrink-0 pt-px">{idx}</span>
                                    <div>
                                        <span className="text-[8px] font-bold text-foreground/70 font-mono">{name}</span>
                                        <p className="text-[7px] text-muted-foreground leading-tight">{desc}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                <div className="flex flex-col items-center flex-shrink-0">
                    <SmartGridStatsBar 
                        stats={stats} 
                        solarOutput={state.env.solarOutput}
                        batterySoC={bestAgent?.batterySoC || 0}
                        gridPrice={state.env.gridPrice}
                        hour={state.env.hour}
                    />
                    <SmartGridCanvas ref={canvasRef} />
                    <GameControls
                        isPlaying={isPlaying}
                        onTogglePlay={() => setIsPlaying(p => !p)}
                        onReset={handleReset}
                    />
                    <div className="w-full mt-8">
                        <PerformanceCharts data={performanceHistory} />
                    </div>
                </div>

                <div className="hidden lg:flex flex-col gap-6 flex-shrink-0 w-80">
                    <div className="bg-card/50 border border-border rounded-2xl p-6 backdrop-blur-md">
                        <h3 className="text-xs font-bold text-yellow-500 uppercase tracking-widest mb-4">
                            Grid Economics
                        </h3>
                        <div className="space-y-4">
                            <p className="text-xs text-muted-foreground leading-relaxed">
                                The AI learns to <span className="text-yellow-400 font-bold">Charge</span> when prices are low or solar is 
                                overflowing, and <span className="text-emerald-400 font-bold">Discharge</span> or 
                                <span className="text-emerald-400 font-bold"> Sell</span> during peak hours to maximize profit.
                            </p>
                            <div className="bg-yellow-500/5 rounded-xl p-3 border border-yellow-500/10">
                                <h4 className="text-[10px] font-bold text-yellow-400 uppercase mb-2">Time-of-Use Rates</h4>
                                <ul className="text-[10px] space-y-1.5 text-muted-foreground">
                                    <li className="flex justify-between">
                                        <span>Off-Peak (22h-06h):</span>
                                        <span className="font-bold">$0.08</span>
                                    </li>
                                    <li className="flex justify-between">
                                        <span>Daytime (10h-17h):</span>
                                        <span className="font-bold">$0.12</span>
                                    </li>
                                    <li className="flex justify-between text-rose-400">
                                        <span>Peak (17h-21h):</span>
                                        <span className="font-bold">$0.30</span>
                                    </li>
                                </ul>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
