import { useEffect, useRef, useState, useCallback } from 'react';
import * as wasm from '../../wasm/pkg/gran_prix_wasm';

import {
    OVEN_POPULATION_SIZE,
    OVEN_INPUTS,
    OVEN_HIDDEN,
    OVEN_OUTPUTS,
    OVEN_MAX_FRAMES,
    OVEN_MAX_TEMP,
    OVEN_AMBIENT_TEMP,
    OvenStats,
    OvenAgent
} from '../../types';
import { PerformanceData, PerformanceCharts } from '../PerformanceCharts';
import { useOvenWasm } from '../../hooks/useOvenWasm';
import { useOvenGameLoop } from '../../hooks/useOvenGameLoop';

import { OvenCanvas, OVEN_CANVAS_WIDTH, OVEN_CANVAS_HEIGHT } from './OvenCanvas';
import { OvenStatsBar } from './OvenStatsBar';
import { OvenNetworkViz } from './OvenNetworkViz';
import { GameControls } from '../GameControls';

const DEFAULT_MUTATION_RATE = 0.15;
const DEFAULT_MUTATION_SCALE = 0.5;

// ─── Drawing helpers ─────────────────────────────────────────────────────────

function getHeatColor(temp: number): string {
    // Normalizes temp from Ambient (25) to Max (300) into a color
    const t = Math.max(0, Math.min(1, (temp - OVEN_AMBIENT_TEMP) / (OVEN_MAX_TEMP - OVEN_AMBIENT_TEMP)));
    // Room temp -> Dark blue/gray, Medium -> Orange/Red, High -> Yellow/White
    if (t < 0.2) return `hsl(210, 40%, ${15 + t * 50}%)`;
    if (t < 0.6) return `hsl(${(1 - (t - 0.2) / 0.4) * 60 + 10}, 80%, ${30 + t * 30}%)`;
    return `hsl(10, 90%, ${50 + (t - 0.6) / 0.4 * 50}%)`;
}

function drawOven(ctx: CanvasRenderingContext2D, bestAgent: OvenAgent | null) {
    // Draw base oven metallic interior
    ctx.fillStyle = '#1a1a1c';
    ctx.fillRect(0, 0, OVEN_CANVAS_WIDTH, OVEN_CANVAS_HEIGHT);

    if (!bestAgent) return;

    const w = OVEN_CANVAS_WIDTH;
    const h = OVEN_CANVAS_HEIGHT;

    // Air gradient glow
    const airGrad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * 0.8);
    airGrad.addColorStop(0, getHeatColor(bestAgent.airTemp));
    airGrad.addColorStop(1, '#111');
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = airGrad;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1.0;

    // Draw Top Heater
    ctx.fillStyle = getHeatColor(OVEN_AMBIENT_TEMP + bestAgent.topHeater * (OVEN_MAX_TEMP - OVEN_AMBIENT_TEMP));
    ctx.fillRect(w * 0.1, 20, w * 0.8, 15);
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 2;
    ctx.strokeRect(w * 0.1, 20, w * 0.8, 15);

    // Draw Bottom Heater
    ctx.fillStyle = getHeatColor(OVEN_AMBIENT_TEMP + bestAgent.bottomHeater * (OVEN_MAX_TEMP - OVEN_AMBIENT_TEMP));
    ctx.fillRect(w * 0.1, h - 35, w * 0.8, 15);
    ctx.strokeRect(w * 0.1, h - 35, w * 0.8, 15);

    // Draw Fan (spinning if active)
    if (bestAgent.fan > 0.5) {
        ctx.save();
        ctx.translate(w - 40, h / 2);
        const time = Date.now() / 50;
        ctx.rotate(time);
        ctx.fillStyle = 'rgba(200, 200, 255, 0.4)';
        ctx.beginPath();
        for (let i = 0; i < 4; i++) {
            ctx.moveTo(0, 0);
            ctx.arc(0, 0, 20, i * Math.PI / 2, i * Math.PI / 2 + 0.5);
            ctx.lineTo(0, 0);
        }
        ctx.fill();
        ctx.restore();
    }
    // Fan housing
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(w - 40, h / 2, 22, 0, Math.PI * 2);
    ctx.stroke();

    // Draw Food
    const foodY = h * 0.6;
    const foodW = 160;
    const foodH = 80;

    // Grill rack
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(20, foodY + foodH / 2);
    ctx.lineTo(w - 20, foodY + foodH / 2);
    for (let x = 30; x < w - 20; x += 15) {
        ctx.moveTo(x, foodY + foodH / 2 - 5);
        ctx.lineTo(x, foodY + foodH / 2 + 5);
    }
    ctx.stroke();

    ctx.save();
    ctx.translate(w / 2, foodY);

    // Food Surface (outer ellipse)
    ctx.fillStyle = getHeatColor(bestAgent.surfaceTemp);
    if (bestAgent.burnt) ctx.fillStyle = '#000'; // completely burnt
    ctx.beginPath();
    ctx.ellipse(0, 0, foodW / 2, foodH / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = bestAgent.burnt ? '#ff0000' : '#885533';
    ctx.lineWidth = 4;
    ctx.stroke();

    // Food Core (inner ellipse)
    ctx.fillStyle = getHeatColor(bestAgent.coreTemp);
    ctx.beginPath();
    ctx.ellipse(0, 0, foodW / 4, foodH / 4, 0, 0, Math.PI * 2);
    ctx.fill();

    // Text labels on food
    ctx.fillStyle = 'white';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${bestAgent.food.type}`, 0, -foodH / 2 - 10);

    ctx.font = '10px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText(`C: ${bestAgent.coreTemp.toFixed(1)}°`, 0, 4);
    ctx.fillText(`S: ${bestAgent.surfaceTemp.toFixed(1)}°`, 0, foodH / 2 - 8);

    ctx.restore();

    // HUD Text
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.textAlign = 'left';
    ctx.font = '11px Inter, sans-serif';
    ctx.fillText(`TARGET CORE: ${bestAgent.food.targetCore}°C`, 10, 50);
    ctx.fillText(`BURN LIMIT:  ${bestAgent.food.burnTemp}°C`, 10, 65);
    ctx.fillText(`ENERGY USED: ${bestAgent.energyUsed.toFixed(0)}`, 10, 80);
    if (bestAgent.cooked && (!bestAgent.burnt)) {
        ctx.fillStyle = '#10b981';
        ctx.font = 'bold 14px monospace';
        ctx.fillText('PERFECTLY COOKED! 🏆', 10, 100);
    } else if (bestAgent.burnt) {
        ctx.fillStyle = '#ef4444';
        ctx.font = 'bold 14px monospace';
        ctx.fillText('BURNT! ❌', 10, 100);
    }
}

// ─── Main Component ────────────────────────────────────────────────────────────

export function OvenDemo() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [stats, setStats] = useState<OvenStats>({ generation: 1, bestFitness: 0, avgFitness: 0, bestCoreTemp: 0, successRate: 0 });
    const [performanceHistory, setPerformanceHistory] = useState<PerformanceData[]>([]);
    const fitnessRef = useRef<Float32Array>(new Float32Array(OVEN_POPULATION_SIZE));

    const { population, initOvenWasm, computeOven, evolveOven } = useOvenWasm();

    const evolve = useCallback((
        fitnessScores: number[], rate: number, scale: number, strategy: wasm.MutationStrategy,
    ) => {
        fitnessRef.current = Float32Array.from(fitnessScores);
        evolveOven(fitnessScores, rate, scale, strategy);
    }, [evolveOven]);

    const onGenerationEnd = useCallback((maxFitness: number, avgFitness: number) => {
        setPerformanceHistory(prev => {
            const nextGen = prev.length > 0 ? prev[prev.length - 1].generation + 1 : 1;
            const newHistory = [...prev, { generation: nextGen, avg: avgFitness, max: maxFitness }];
            return newHistory.slice(-60);
        });
    }, []);

    const { gameState, resetOven, updatePhysics } = useOvenGameLoop({
        computeOven, evolve, setStats,
        mutationRate: DEFAULT_MUTATION_RATE,
        mutationScale: DEFAULT_MUTATION_SCALE,
        mutationStrategy: wasm.MutationStrategy.Additive,
        onGenerationEnd,
    });

    useEffect(() => {
        if (!population) {
            initOvenWasm().then(() => resetOven());
        }
    }, [initOvenWasm, population, resetOven]);

    const render = useCallback((ctx: CanvasRenderingContext2D) => {
        const state = gameState.current;
        const sorted = [...state.agents].sort((a, b) => b.fitness - a.fitness);
        const bestAgent = sorted[0] || null;

        drawOven(ctx, bestAgent);
    }, [gameState]);

    // Game loop
    const rafId = useRef<number | null>(null);
    const isLoopActive = useRef(false);

    const gameLoop = useCallback(() => {
        if (!isPlaying) { isLoopActive.current = false; return; }
        if (!canvasRef.current) { rafId.current = requestAnimationFrame(gameLoop); return; }
        const ctx = canvasRef.current.getContext('2d');
        if (!ctx) return;

        // Run multiple ticks per frame to speed up the slow heating process a bit
        for (let i = 0; i < 3; i++) updatePhysics();

        render(ctx);
        rafId.current = requestAnimationFrame(gameLoop);
    }, [isPlaying, updatePhysics, render]);

    useEffect(() => {
        if (isPlaying && !isLoopActive.current) {
            isLoopActive.current = true;
            rafId.current = requestAnimationFrame(gameLoop);
        }
        return () => { if (rafId.current) cancelAnimationFrame(rafId.current); isLoopActive.current = false; };
    }, [isPlaying, gameLoop]);

    const handleReset = useCallback(() => {
        setIsPlaying(false);
        resetOven();
        setStats({ generation: 1, bestFitness: 0, avgFitness: 0, bestCoreTemp: 0, successRate: 0 });
        setPerformanceHistory([]);
        fitnessRef.current = new Float32Array(OVEN_POPULATION_SIZE);
    }, [resetOven]);

    // ── Loading guard ─────────────────────────────────────────────────────────
    if (!population) {
        return (
            <div className="w-full flex flex-col items-center justify-center py-24 gap-4">
                <div className="w-12 h-12 border-4 border-orange-500/20 border-t-orange-500 rounded-full animate-spin" />
                <span className="text-[10px] uppercase font-black tracking-[0.3em] text-orange-500">
                    Initializing Thermocouples WASM…
                </span>
            </div>
        );
    }

    const state = gameState.current;
    const sorted = [...state.agents].sort((a, b) => b.fitness - a.fitness);
    const bestAgent = sorted[0];

    return (
        <div className="w-full flex flex-col items-center gap-0">
            {/* ── Header ──────────────────────────────────────────────────────── */}
            <div className="flex flex-col items-center mb-8">
                <h2 className="text-2xl font-black bg-gradient-to-br from-orange-400 to-red-600 bg-clip-text text-transparent uppercase tracking-[0.3em]">
                    Smart Oven IoT
                </h2>
                <p className="text-[9px] text-muted-foreground uppercase tracking-[0.3em] mt-2 font-bold text-center">
                    Edge AI Thermodynamics Control<br />
                    {OVEN_POPULATION_SIZE} Agents · Air/Surface/Core Tracking
                </p>
            </div>

            {/* ── Main layout: left panel | canvas | right panel ───────────── */}
            <div className="w-full max-w-7xl flex flex-col lg:flex-row items-center lg:items-start justify-center gap-8">

                {/* Left panel — Brain Inspector + Input Schema */}
                <div className="flex flex-col gap-6 flex-shrink-0 w-80">
                    <div className="bg-card/50 border border-border rounded-2xl overflow-hidden backdrop-blur-md p-6">
                        <div className="border-b border-border pb-3 mb-5">
                            <h3 className="text-sm font-bold text-foreground uppercase tracking-tighter">
                                Edge Controller
                            </h3>
                            <p className="text-[9px] text-muted-foreground font-mono mt-0.5">
                                BEST_AGENT · IOT_WEIGHTS
                            </p>
                        </div>
                        <OvenNetworkViz population={population} fitnessScores={fitnessRef.current} />

                        {/* Input legend */}
                        <div className="mt-5 space-y-1.5 border-t border-border pt-4">
                            <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
                                Sensor Inputs (11)
                            </p>
                            {[
                                ['I₁', 'AirTemp', 'Internal air temperature [0..300C]'],
                                ['I₂', 'SurfaceTemp', 'Food crust temperature [0..300C]'],
                                ['I₃', 'CoreTemp', 'Deep center temperature [0..100C]'],
                                ['I₄', 'Target_err', 'Missing degrees to Target Core'],
                                ['I₅', 'Burn_err', 'Degrees until crust burns'],
                                ['I₆', 'Time%', '% of baking cycle completed'],
                                ['I₇₋₁₀', 'Food Type', 'One-hot: Cake/Bread/Turkey/Pizza'],
                                ['I₁₁', 'Moisture', 'Remaining water content [0..1]'],
                            ].map(([id, name, desc]) => (
                                <div key={id} className="flex items-start gap-2">
                                    <span className="text-[7px] font-mono text-orange-500 w-5 flex-shrink-0 pt-px">
                                        {id}
                                    </span>
                                    <div>
                                        <span className="text-[7px] font-bold text-foreground/70 font-mono">
                                            {name}
                                        </span>
                                        <p className="text-[6px] text-muted-foreground leading-tight">
                                            {desc}
                                        </p>
                                    </div>
                                </div>
                            ))}
                            <div className="mt-3 pt-3 border-t border-border">
                                <p className="text-[8px] text-muted-foreground">
                                    <span className="text-orange-400 font-mono font-bold">3 outputs</span>
                                    {' '}→ TopHeater, BottomHeater, Fan [0..1]
                                </p>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Centre — canvas + stats + controls + chart */}
                <div className="flex flex-col items-center flex-shrink-0">
                    <OvenStatsBar
                        stats={stats}
                        frame={state.frame}
                        currentFood={state.currentFoodType}
                        bestAir={bestAgent?.airTemp || OVEN_AMBIENT_TEMP}
                        bestSurface={bestAgent?.surfaceTemp || OVEN_AMBIENT_TEMP}
                    />
                    <OvenCanvas ref={canvasRef} />
                    <GameControls
                        isPlaying={isPlaying}
                        onTogglePlay={() => setIsPlaying(p => !p)}
                        onReset={handleReset}
                    />
                    <div className="w-full mt-8">
                        <PerformanceCharts data={performanceHistory} />
                    </div>
                </div>

                {/* Right panel — Evolution Config + Reward Function */}
                <div className="flex flex-col gap-6 flex-shrink-0 w-80">
                    <div className="bg-card/50 border border-border rounded-2xl overflow-hidden backdrop-blur-md">
                        <div className="p-4 border-b border-border bg-card/80">
                            <h3 className="text-sm font-bold text-foreground uppercase tracking-tighter">
                                PID Evolutivo
                            </h3>
                            <p className="text-[9px] text-muted-foreground font-mono mt-0.5">
                                OVEN_THERMO_PROTOCOL
                            </p>
                        </div>
                        <div className="p-5 space-y-5">
                            {/* Strategy */}
                            <div className="space-y-2">
                                <label className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground block">
                                    Mutation Strategy
                                </label>
                                <div className="flex items-center gap-2 px-3 py-2 bg-orange-500/10 border border-orange-500/30 rounded-lg">
                                    <span className="w-1.5 h-1.5 rounded-full bg-orange-500 shadow-[0_0_6px_rgba(249,115,22,0.5)]" />
                                    <span className="text-[10px] font-bold text-orange-400 uppercase tracking-wider">
                                        Additive
                                    </span>
                                </div>
                                <div className="bg-orange-500/5 border border-orange-500/10 p-3 rounded-lg mt-2">
                                    <p className="text-[9px] font-mono text-orange-500/80 mb-1">
                                        w_next = w + random(-s, s)
                                    </p>
                                    <p className="text-[8px] text-muted-foreground italic">
                                        Refinamento suave para achar o ponto de PID perfeito.
                                    </p>
                                </div>
                            </div>

                            {/* Rates */}
                            <div className="space-y-3 pt-2 border-t border-border">
                                {[
                                    ['Mutation Rate', `${(DEFAULT_MUTATION_RATE * 100).toFixed(0)}%`, true],
                                    ['Mutation Scale', DEFAULT_MUTATION_SCALE.toFixed(2), true],
                                    ['Population', `${OVEN_POPULATION_SIZE}`, false],
                                    ['Network', `${OVEN_INPUTS} → ${OVEN_HIDDEN} → ${OVEN_OUTPUTS}`, false],
                                    ['Max Frames', `${OVEN_MAX_FRAMES}`, false],
                                ].map(([label, value, accent]) => (
                                    <div key={label as string} className="flex justify-between items-center">
                                        <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
                                            {label}
                                        </span>
                                        <span className={`text-sm font-mono font-bold ${accent ? 'text-orange-400' : 'text-foreground/70'}`}>
                                            {value}
                                        </span>
                                    </div>
                                ))}
                            </div>

                            {/* Reward info */}
                            <div className="space-y-2 pt-2 border-t border-border">
                                <label className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground block">
                                    Fitness Function
                                </label>
                                <div className="space-y-1.5">
                                    {[
                                        ['+(T-25)', 'Pontos base = Temp Core alcançada'],
                                        ['+500', 'Bônus se cozinhar perfeitamente (atingiu Target, sem queimar)'],
                                        ['+Moist', 'Bônus por preservar umidade'],
                                        ['-200', 'Penalidade fatal caso queime (Surface > BurnTemp)'],
                                        ['-Time', 'Penalidade por demorar demais'],
                                        ['-Energy', 'Penalidade por desperdício elétrico'],
                                    ].map(([reward, desc]) => (
                                        <div key={reward} className="flex items-center gap-2">
                                            <span
                                                className={`text-[9px] font-mono font-bold w-12 text-right ${(reward as string).startsWith('+')
                                                    ? 'text-orange-400'
                                                    : 'text-rose-500'
                                                    }`}
                                            >
                                                {reward}
                                            </span>
                                            <span className="text-[8px] text-muted-foreground">
                                                {desc}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* Food details */}
                            <div className="space-y-2 pt-2 border-t border-border">
                                <label className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground block">
                                    Thermodynamics (Foods)
                                </label>
                                <div className="space-y-1">
                                    <div className="flex items-center gap-2"><span className="text-sm">🎂</span><span className="text-[8px] text-muted-foreground">Bolo: Core 95°C / Queima 160°C</span></div>
                                    <div className="flex items-center gap-2"><span className="text-sm">🥖</span><span className="text-[8px] text-muted-foreground">Pão: Core 95°C / Queima 210°C (Lento)</span></div>
                                    <div className="flex items-center gap-2"><span className="text-sm">🦃</span><span className="text-[8px] text-muted-foreground">Peru: Core 75°C / Queima 180°C (Muuito Lento)</span></div>
                                    <div className="flex items-center gap-2"><span className="text-sm">🍕</span><span className="text-[8px] text-muted-foreground">Pizza: Core 85°C / Queima 240°C (Rápido)</span></div>
                                </div>
                            </div>
                        </div>

                        <div className="p-3 bg-muted/50 border-t border-border text-[8px] text-muted-foreground font-mono text-center tracking-widest">
                            IOT_EDGE_PROTOCOL • SMART_OVEN
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
