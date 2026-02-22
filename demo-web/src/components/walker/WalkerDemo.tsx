import React, {
    useEffect,
    useRef,
    useState,
    useCallback,
} from 'react';
import {
    WALKER_WIDTH,
    WALKER_HEIGHT,
    WalkerStats,
} from '../../types/walker';
import { useSimulation } from '../../hooks/useSimulation';
import { 
    walkerSimulationConfig, 
    WalkerSimulationState, 
    WalkerAgent 
} from '../../demos/walker/walkerSimulation';
import {
    drawWalker,
    drawGround,
    PX_PER_METER,
} from '../../lib/walkerPhysics';

import { WalkerCanvas } from './WalkerCanvas';
import { WalkerStatsBar } from './WalkerStatsBar';
import { WalkerControls } from './WalkerControls';
import { WalkerNetworkViz } from './WalkerNetworkViz';
import { PerformanceCharts } from '../PerformanceCharts';
import { drawBackground, drawHUD } from './renderers';

export const WalkerDemo: React.FC = () => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rafRef = useRef<number | null>(null);
    const isLoopActive = useRef(false);

    const [isPlaying, setIsPlaying] = useState(false);
    
    // Unified Simulation Engine
    const { internalState, stats, performanceHistory, isReady, update, reset, engine } = useSimulation<WalkerAgent, WalkerSimulationState, WalkerStats>(walkerSimulationConfig);

    const handleReset = useCallback(() => {
        setIsPlaying(false);
        reset();
    }, [reset]);

    // ── Canvas render (imperative — no React state involved) ──────────────────
    const render = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const state = internalState.current;
        if (!state) return;
        const walkers = state.walkers;
        const isDark =
            document.documentElement.getAttribute('data-theme') !== 'light' &&
            !document.documentElement.classList.contains('light');

        drawBackground(ctx, isDark);

        // ── Camera: follow the best alive walker ─────────────────────────────
        let bestX = 2; // default to spawn area
        let bestIdx = -1;
        state.agents.forEach((agent, i) => {
            if (!agent.dead && agent.distance > bestX - 2) {
                bestX = walkers[i]?.torso.getPosition().x ?? bestX;
                bestIdx = i;
            }
        });

        // Camera offset: keep best walker at ~30% from left
        const cameraX = bestX * PX_PER_METER - WALKER_WIDTH * 0.3;

        // Ground Y in canvas coords (physics Y=0 = ground)
        const groundCanvasY = WALKER_HEIGHT - 60;

        ctx.save();
        ctx.translate(-cameraX, groundCanvasY);

        // ── Draw ground ─────────────────────────────────────────────────────
        drawGround(ctx, WALKER_WIDTH + cameraX + 200, 0, isDark);

        // ── Draw walkers ────────────────────────────────────────────────────
        walkers.forEach((walker, i) => {
            const agent = state.agents[i];
            if (!agent) return;

            const alpha = agent.dead ? 0.08 : 0.85;
            const color = agent.dead
                ? (isDark ? '#333' : '#ccc')
                : agent.color;

            drawWalker(ctx, walker, color, alpha);
        });

        ctx.restore();

        // ── Draw HUD (not affected by camera transform) ─────────────────────
        const alive = state.agents.filter(a => !a.dead).length;
        drawHUD(ctx, state.generation, state.frame, alive);

        // Distance marker for best walker
        if (bestIdx >= 0) {
            const dist = state.agents[bestIdx].distance;
            ctx.font = 'bold 10px Inter, system-ui, sans-serif';
            ctx.fillStyle = 'rgba(16, 185, 129, 0.7)';
            ctx.textAlign = 'right';
            ctx.fillText(`BEST: ${dist.toFixed(2)}m`, WALKER_WIDTH - 12, 20);
        }
    }, [internalState]);

    // ── Game loop ─────────────────────────────────────────────────────────────
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

    const state = internalState.current!;

    if (!isReady || !stats || !state) {
        return (
            <div className="w-full h-[500px] flex flex-col items-center justify-center gap-4 bg-card/30 rounded-3xl border border-border/50 backdrop-blur-sm">
                <div className="w-12 h-12 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin" />
                <span className="text-[10px] uppercase font-black tracking-[0.3em] text-emerald-500 animate-pulse">
                    Initializing Physics Engine…
                </span>
            </div>
        );
    }

    return (
        <div className="w-full flex flex-col items-center">
            <div className="flex flex-col items-center mb-10">
                <h2 className="text-3xl font-black bg-gradient-to-br from-emerald-400 to-teal-400 bg-clip-text text-transparent uppercase tracking-[0.4em] drop-shadow-sm">
                    Bipedal Walker
                </h2>
                <div className="flex items-center gap-3 mt-3">
                    <span className="h-px w-8 bg-emerald-500/30" />
                    <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-[0.3em]">
                        Neural Motor Coordination
                    </p>
                    <span className="h-px w-8 bg-emerald-500/30" />
                </div>
            </div>

            <div className="w-full max-w-7xl flex flex-col xl:flex-row items-center xl:items-start justify-center gap-10">
                <div className="flex flex-col gap-8 flex-shrink-0 w-[340px]">
                    <div className="bg-card/40 border border-border/50 rounded-[2rem] overflow-hidden backdrop-blur-xl shadow-2xl shadow-emerald-500/5">
                        <div className="p-6 border-b border-border/50 bg-card/60">
                            <h3 className="text-xs font-black text-foreground uppercase tracking-[0.2em] flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                                Neural Architecture
                            </h3>
                        </div>
                        <div className="p-8">
                            <WalkerNetworkViz
                                population={(engine as any)?.populations.get('walkers')}
                                fitnessScores={engine?.fitnessScores.get('walkers')}
                            />
                            
                            <div className="mt-8 space-y-4 pt-6 border-t border-border/50">
                                <div>
                                    <label className="text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground block mb-3">
                                        Sensor Inputs (10)
                                    </label>
                                    <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                                        {[
                                            'Torso Angle', 'Angular Vel',
                                            'Hip L Angle', 'Hip L Vel',
                                            'Knee L Angle', 'Knee L Vel',
                                            'Hip R Angle', 'Hip R Vel',
                                            'Knee R Angle', 'Knee R Vel'
                                        ].map((label, i) => (
                                            <div key={label} className="flex items-center gap-2 opacity-70">
                                                <span className="text-[8px] font-mono text-emerald-500">I{i}</span>
                                                <span className="text-[9px] font-medium">{label}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                                
                                <div className="pt-2">
                                    <label className="text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground block mb-3">
                                        Motor Outputs (4)
                                    </label>
                                    <div className="flex gap-4">
                                        {['Leg L', 'Knee L', 'Leg R', 'Knee R'].map((label, i) => (
                                            <div key={label} className="flex flex-col items-center">
                                                <span className="text-[8px] font-mono text-emerald-500">O{i}</span>
                                                <span className="text-[8px] font-bold uppercase mt-1">{label}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="flex flex-col items-center flex-grow max-w-[800px]">
                    <WalkerStatsBar stats={stats} />
                    <WalkerCanvas ref={canvasRef} width={WALKER_WIDTH} height={WALKER_HEIGHT} />
                    <div className="w-full mt-6 bg-card/30 border border-border/50 rounded-2xl p-4 backdrop-blur-sm">
                        <WalkerControls
                            isPlaying={isPlaying}
                            onTogglePlay={() => setIsPlaying(p => !p)}
                            onReset={handleReset}
                        />
                    </div>
                    
                    <div className="w-full mt-8 grid grid-cols-1 gap-6">
                         <div className="bg-card/40 border border-border/50 rounded-3xl p-6 backdrop-blur-md">
                            <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground mb-4 px-2">
                                Evolution Progress
                            </h3>
                            <PerformanceCharts data={performanceHistory} />
                        </div>
                    </div>
                </div>

                <div className="hidden xl:flex flex-col gap-6 flex-shrink-0 w-80">
                    <div className="bg-card/40 border border-border/50 rounded-[2rem] p-8 backdrop-blur-md">
                        <h3 className="text-xs font-black text-emerald-500 uppercase tracking-[0.2em] mb-6 border-b border-border/50 pb-4">
                            Training Goal
                        </h3>
                        <div className="space-y-6">
                            <div className="space-y-2">
                                <p className="text-[11px] text-muted-foreground leading-relaxed">
                                    Agents are rewarded for <span className="text-emerald-400 font-bold">horizontal distance</span> traveled without falling.
                                </p>
                            </div>
                            
                            <div className="bg-zinc-950/40 rounded-2xl p-4 border border-border/30">
                                <h4 className="text-[9px] font-black uppercase tracking-[0.1em] text-emerald-500/70 mb-3">
                                    Fitness Calculation
                                </h4>
                                <ul className="space-y-2">
                                    <li className="flex items-center gap-2 text-[10px]">
                                        <div className="w-1 h-1 rounded-full bg-emerald-500" />
                                        <span>Distance × 100</span>
                                    </li>
                                    <li className="flex items-center gap-2 text-[10px]">
                                        <div className="w-1 h-1 rounded-full bg-emerald-500" />
                                        <span>Survival Bonus (0.1/frame)</span>
                                    </li>
                                    <li className="flex items-center gap-2 text-[10px] text-rose-500/70">
                                        <div className="w-1 h-1 rounded-full bg-rose-500" />
                                        <span>Death = Termination</span>
                                    </li>
                                </ul>
                            </div>

                            <p className="text-[11px] text-muted-foreground leading-relaxed italic opacity-80">
                                Watching them fall is part of the process. Coordination emerges after ~20 generations.
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
