import { useEffect, useRef, useCallback } from 'react';
import {
    OVEN_POPULATION_SIZE,
    OVEN_MAX_TEMP,
    OVEN_AMBIENT_TEMP,
    OvenStats,
    OvenFoodType,
    OvenAgent,
    OVEN_INPUTS,
    OVEN_HIDDEN,
    OVEN_OUTPUTS,
    OVEN_MAX_FRAMES,
} from '../../types/oven';
import { PerformanceCharts } from '../PerformanceCharts';

import { useSimulation } from '../../hooks/useSimulation';
import { ovenSimulationConfig, OvenSimulationState } from '../../demos/oven/ovenSimulation';

import { OvenCanvas } from './OvenCanvas';
import { OvenStatsBar } from './OvenStatsBar';
import { OvenNetworkViz } from './OvenNetworkViz';
import { GameControls } from '../GameControls';
import { drawOven } from './renderers';

export function OvenDemo() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const { 
        engine, 
        internalState, 
        stats, 
        performanceHistory,
        isPlaying, 
        setIsPlaying, 
        reset 
    } = useSimulation<OvenAgent, OvenSimulationState, OvenStats>(ovenSimulationConfig, {
        currentFoodType: OvenFoodType.Cake,
        restingFrames: 0
    });

    const render = useCallback((ctx: CanvasRenderingContext2D) => {
        const state = internalState.current;
        if (!state) return;
        const sorted = [...state.agents].sort((a, b) => b.fitness - a.fitness);
        const bestAgent = sorted[0] || null;

        drawOven(ctx, bestAgent, OVEN_AMBIENT_TEMP, OVEN_MAX_TEMP);
    }, [internalState]);

    // Game loop
    const rafId = useRef<number | null>(null);
    const isLoopActive = useRef(false);

    const gameLoop = useCallback(() => {
        if (!isPlaying) { isLoopActive.current = false; return; }
        if (!canvasRef.current) { rafId.current = requestAnimationFrame(gameLoop); return; }
        const ctx = canvasRef.current.getContext('2d');
        if (!ctx) return;

        // Run multiple ticks per frame to speed up the slow heating process a bit
        for (let i = 0; i < 3; i++) engine?.tick();

        render(ctx);
        rafId.current = requestAnimationFrame(gameLoop);
    }, [isPlaying, engine, render]);

    useEffect(() => {
        if (isPlaying && !isLoopActive.current) {
            isLoopActive.current = true;
            rafId.current = requestAnimationFrame(gameLoop);
        }
        return () => { if (rafId.current) cancelAnimationFrame(rafId.current); isLoopActive.current = false; };
    }, [isPlaying, gameLoop]);

    const handleReset = useCallback(() => {
        setIsPlaying(false);
        reset();
    }, [reset, setIsPlaying]);

    // ── Loading guard ─────────────────────────────────────────────────────────
    if (!engine) {
        return (
            <div className="w-full flex flex-col items-center justify-center py-24 gap-4">
                <div className="w-12 h-12 border-4 border-orange-500/20 border-t-orange-500 rounded-full animate-spin" />
                <span className="text-[10px] uppercase font-black tracking-[0.3em] text-orange-500">
                    Initializing Thermocouples WASM…
                </span>
            </div>
        );
    }

    const state = internalState.current!;
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
                        <OvenNetworkViz 
                            population={engine?.populations.get('ovens') || null} 
                            fitnessScores={engine?.fitnessScores.get('ovens')} 
                        />

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
                        stats={stats!}
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

                                <div className="space-y-3 pt-2 border-t border-border">
                                    {[
                                        ['Mutation Rate', `${(ovenSimulationConfig.mutationRate! * 100).toFixed(0)}%`, true],
                                        ['Mutation Scale', ovenSimulationConfig.mutationScale!.toFixed(2), true],
                                        ['Population', `${OVEN_POPULATION_SIZE}`, false],
                                        ['Network', `${OVEN_INPUTS} → ${OVEN_HIDDEN.join(', ')} → ${OVEN_OUTPUTS}`, false],
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
                                        ['+(T-25)*2', 'Pontos pesados baseados no aquecimento até o centro'],
                                        ['+500', 'Bônus se cozinhar perfeitamente (atingiu Target, sem queimar)'],
                                        ['+Moist', 'Bônus por preservar umidade'],
                                        ['-40%', 'Perde apenas 40% dos pontos se queimar (protege o gradiente)'],
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
