import React, {
    useEffect,
    useRef,
    useState,
    useCallback,
} from 'react';
import * as wasm from '../../wasm/pkg/gran_prix_wasm';

import {
    WALKER_WIDTH,
    WALKER_HEIGHT,
    WALKER_POPULATION_SIZE,
    WALKER_INPUTS,
    WALKER_HIDDEN,
    WALKER_OUTPUTS,
    WalkerStats,
} from '../../types/walker';
import { PerformanceData } from '../PerformanceCharts';
import { useWalkerWasm } from '../../hooks/useWalkerWasm';
import { useWalkerGameLoop } from '../../hooks/useWalkerGameLoop';
import {
    drawWalker,
    drawGround,
    PX_PER_METER,
} from '../../lib/walkerPhysics';
import { WALKER_EVOLUTION_CONFIG } from '../../config/walker.config';

import { WalkerCanvas } from './WalkerCanvas';
import { WalkerStatsBar } from './WalkerStatsBar';
import { WalkerControls } from './WalkerControls';
import { WalkerNetworkViz } from './WalkerNetworkViz';
import { WalkerFitnessChart } from './WalkerFitnessChart';
import { drawBackground, drawHUD } from './renderers';

/**
 * WalkerDemo — main orchestrator for the Bipedal Walker neuro-evolution frame.
 *
 * Responsibilities:
 * - Owns WASM lifecycle via useWalkerWasm
 * - Owns physics via useWalkerGameLoop (planck.js world)
 * - Drives the imperative canvas render loop via requestAnimationFrame
 * - Camera follows the farthest-traveling walker
 * - Composes all sub-components (stats, controls, network viz, fitness chart)
 *
 * Separation of concerns:
 * - All mutable simulation state lives in refs (no frame-rate React state)
 * - Only aggregated stats flow through useState
 * - Canvas rendering is 100% imperative
 */
export const WalkerDemo: React.FC = () => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rafRef = useRef<number | null>(null);
    const isLoopActive = useRef(false);

    const [isPlaying, setIsPlaying] = useState(false);
    const [stats, setStats] = useState<WalkerStats>({
        generation: 1,
        alive: 0,
        best: 0,
        avgDistance: 0,
    });
    const [performanceHistory, setPerformanceHistory] = useState<PerformanceData[]>([]);
    const fitnessRef = useRef<Float32Array>(new Float32Array(WALKER_POPULATION_SIZE));

    // WASM — isolated population for Walker
    const { population, initWalkerWasm, computeWalker, evolveWalker } = useWalkerWasm();

    /** Called by useWalkerGameLoop after every generation to record chart data. */
    const handleGenerationEnd = useCallback(
        (maxFitness: number, avgFitness: number) => {
            setPerformanceHistory(prev => {
                const nextGen = prev.length > 0 ? prev[prev.length - 1].generation + 1 : 1;
                const updated = [...prev, { generation: nextGen, max: maxFitness, avg: avgFitness }];
                return updated.slice(-60);
            });
        },
        [],
    );

    /** Wrapped evolve that also forwards fitness array reference for the viz. */
    const evolveWithTracking = useCallback(
        (
            fitnessScores: number[],
            rate: number,
            scale: number,
            strategy: wasm.MutationStrategy,
        ) => {
            fitnessRef.current = Float32Array.from(fitnessScores);
            evolveWalker(fitnessScores, rate, scale, strategy);
        },
        [evolveWalker],
    );

    const { gameState, walkersRef, resetWalker, updateWalkerPhysics } = useWalkerGameLoop({
        computeWalker,
        evolve: evolveWithTracking,
        setStats,
        mutationRate: WALKER_EVOLUTION_CONFIG.mutationRate,
        mutationScale: WALKER_EVOLUTION_CONFIG.mutationScale,
        mutationStrategy: WALKER_EVOLUTION_CONFIG.mutationStrategy,
        onGenerationEnd: handleGenerationEnd,
    });

    // ── Init WASM and seed walkers ──────────────────────────────────────────
    useEffect(() => {
        if (!population) {
            initWalkerWasm().then(() => {
                resetWalker();
                setStats(s => ({ ...s, alive: WALKER_POPULATION_SIZE }));
            });
        }
    }, [initWalkerWasm, population, resetWalker]);

    // ── Canvas render (imperative — no React state involved) ──────────────────
    const render = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const state = gameState.current;
        const walkers = walkersRef.current;
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
    }, [gameState, walkersRef]);

    // ── Game loop ─────────────────────────────────────────────────────────────
    const gameLoop = useCallback(() => {
        if (!isPlaying) {
            isLoopActive.current = false;
            return;
        }
        updateWalkerPhysics();
        render();
        rafRef.current = requestAnimationFrame(gameLoop);
    }, [isPlaying, updateWalkerPhysics, render]);

    useEffect(() => {
        if (isPlaying && !isLoopActive.current) {
            isLoopActive.current = true;
            rafRef.current = requestAnimationFrame(gameLoop);
        }
        return () => {
            if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
            isLoopActive.current = false;
        };
    }, [isPlaying, gameLoop]);

    // ── Handlers ──────────────────────────────────────────────────────────────
    const handleReset = useCallback(() => {
        setIsPlaying(false);
        resetWalker();
        setStats({ generation: 1, alive: WALKER_POPULATION_SIZE, best: 0, avgDistance: 0 });
        setPerformanceHistory([]);
        fitnessRef.current = new Float32Array(WALKER_POPULATION_SIZE);
    }, [resetWalker]);

    // ── Loading guard ─────────────────────────────────────────────────────────
    if (!population) {
        return (
            <div className="w-full flex flex-col items-center justify-center py-24 gap-4">
                <div className="w-12 h-12 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin" />
                <span className="text-[10px] uppercase font-black tracking-[0.3em] text-emerald-500">
                    Initializing WASM Engine…
                </span>
            </div>
        );
    }

    return (
        <div className="w-full flex flex-col items-center gap-0">
            {/* ── Header ───────────────────────────────────────────────────── */}
            <div className="flex flex-col items-center mb-8">
                <h2 className="text-2xl font-black bg-gradient-to-br from-orange-400 to-rose-400 bg-clip-text text-transparent uppercase tracking-[0.3em]">
                    Bipedal Walker
                </h2>
                <p className="text-[9px] text-muted-foreground uppercase tracking-[0.3em] mt-2 font-bold">
                    Motor Synergy · {WALKER_POPULATION_SIZE} Agents · Continuous Control · planck.js
                </p>
            </div>

            {/* ── Main layout: left panel | canvas | right panel ───────────── */}
            <div className="w-full max-w-7xl flex flex-col lg:flex-row items-center lg:items-start justify-center gap-8">

                {/* Left panel — network viz */}
                <div className="flex flex-col gap-6 flex-shrink-0 w-80">
                    <div className="bg-card/50 border border-border rounded-2xl overflow-hidden backdrop-blur-md p-6">
                        <div className="border-b border-border pb-3 mb-5">
                            <h3 className="text-sm font-bold text-foreground uppercase tracking-tighter">
                                Brain Inspector
                            </h3>
                            <p className="text-[9px] text-muted-foreground font-mono mt-0.5">
                                BEST_AGENT · LIVE_WEIGHTS
                            </p>
                        </div>
                        <WalkerNetworkViz
                            population={population}
                            fitnessScores={fitnessRef.current}
                        />

                        {/* Input legend */}
                        <div className="mt-5 space-y-1.5 border-t border-border pt-4">
                            <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
                                Input Schema (10 sensors)
                            </p>
                            {[
                                ['I₁', 'body_θ', 'Torso tilt angle'],
                                ['I₂', 'body_ω', 'Torso angular velocity'],
                                ['I₃', 'hip_L_θ', 'Left hip angle'],
                                ['I₄', 'hip_L_ω', 'Left hip velocity'],
                                ['I₅', 'knee_L_θ', 'Left knee angle'],
                                ['I₆', 'knee_L_ω', 'Left knee velocity'],
                                ['I₇', 'hip_R_θ', 'Right hip angle'],
                                ['I₈', 'hip_R_ω', 'Right hip velocity'],
                                ['I₉', 'knee_R_θ', 'Right knee angle'],
                                ['I₁₀', 'knee_R_ω', 'Right knee velocity'],
                            ].map(([id, name, desc]) => (
                                <div key={id} className="flex items-start gap-2">
                                    <span className="text-[7px] font-mono text-emerald-500 w-5 flex-shrink-0 pt-px">
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
                                    <span className="text-orange-400 font-mono font-bold">4 outputs</span>
                                    {' '}→ continuous motor torques [-1, 1]
                                </p>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Centre — canvas + stats + controls + chart */}
                <div className="flex flex-col items-center flex-shrink-0">
                    <WalkerStatsBar stats={stats} />
                    <WalkerCanvas
                        ref={canvasRef}
                        width={WALKER_WIDTH}
                        height={WALKER_HEIGHT}
                    />
                    <WalkerControls
                        isPlaying={isPlaying}
                        onTogglePlay={() => setIsPlaying(p => !p)}
                        onReset={handleReset}
                    />
                    <div className="w-full mt-8">
                        <WalkerFitnessChart data={performanceHistory} />
                    </div>
                </div>

                {/* Right panel — evolution & reward info */}
                <div className="flex flex-col gap-6 flex-shrink-0 w-80">
                    <div className="bg-card/50 border border-border rounded-2xl overflow-hidden backdrop-blur-md">
                        <div className="p-4 border-b border-border bg-card/80">
                            <h3 className="text-sm font-bold text-foreground uppercase tracking-tighter">
                                Evolution Config
                            </h3>
                            <p className="text-[9px] text-muted-foreground font-mono mt-0.5">
                                MOTOR_SYNERGY_PROTOCOL
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
                                        Refinamento local — preserva coordenação motora aprendida.
                                    </p>
                                </div>
                            </div>

                            {/* Rates */}
                            <div className="space-y-3 pt-2 border-t border-border">
                                <div className="flex justify-between items-center">
                                    <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
                                        Mutation Rate
                                    </span>
                                    <span className="text-sm font-mono font-bold text-orange-400">
                                        {(WALKER_EVOLUTION_CONFIG.mutationRate * 100).toFixed(0)}%
                                    </span>
                                </div>
                                <div className="flex justify-between items-center">
                                    <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
                                        Mutation Scale
                                    </span>
                                    <span className="text-sm font-mono font-bold text-orange-400">
                                        {WALKER_EVOLUTION_CONFIG.mutationScale.toFixed(2)}
                                    </span>
                                </div>
                                <div className="flex justify-between items-center">
                                    <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
                                        Population
                                    </span>
                                    <span className="text-sm font-mono font-bold text-foreground/70">
                                        {WALKER_POPULATION_SIZE}
                                    </span>
                                </div>
                                <div className="flex justify-between items-center">
                                    <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
                                        Network
                                    </span>
                                    <span className="text-sm font-mono font-bold text-foreground/70">
                                        {WALKER_INPUTS} → {WALKER_HIDDEN} → {WALKER_OUTPUTS}
                                    </span>
                                </div>
                                <div className="flex justify-between items-center">
                                    <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
                                        Gen Length
                                    </span>
                                    <span className="text-sm font-mono font-bold text-foreground/70">
                                        600 frames
                                    </span>
                                </div>
                            </div>

                            {/* Reward info */}
                            <div className="space-y-2 pt-2 border-t border-border">
                                <label className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground block">
                                    Reward Function
                                </label>
                                <div className="space-y-1.5">
                                    {[
                                        ['+100×d', 'Horizontal distance (d) in metres'],
                                        ['+0.1/f', 'Per frame survived'],
                                        ['death', 'Torso below 0.7m or tilt > 80°'],
                                    ].map(([reward, desc]) => (
                                        <div key={reward} className="flex items-center gap-2">
                                            <span
                                                className={`text-[9px] font-mono font-bold w-12 text-right ${reward.startsWith('+')
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
                        </div>

                        <div className="p-3 bg-muted/50 border-t border-border text-[8px] text-muted-foreground font-mono text-center tracking-widest">
                            STRATEGY_PRIX_v2 • BIPEDAL_WALKER_ACTIVE
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
