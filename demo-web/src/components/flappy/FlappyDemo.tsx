import React, {
    useEffect,
    useRef,
    useState,
    useCallback,
} from 'react';
import * as wasm from '../../wasm/pkg/gran_prix_wasm';

import {
    FLAPPY_WIDTH,
    FLAPPY_HEIGHT,
    FLAPPY_POPULATION_SIZE,
    FlappyStats,
} from '../../types/flappy';
import { PerformanceData } from '../PerformanceCharts';
import { useFlappyWasm } from '../../hooks/useFlappyWasm';
import { useFlappyGameLoop } from '../../hooks/useFlappyGameLoop';
import { FLAPPY_EVOLUTION_CONFIG } from '../../config/flappy.config';

import { FlappyCanvas } from './FlappyCanvas';
import { FlappyStatsBar } from './FlappyStatsBar';
import { FlappyControls } from './FlappyControls';
import { FlappyNetworkViz } from './FlappyNetworkViz';
import { FlappyFitnessChart } from './FlappyFitnessChart';
import { drawBackground, drawPipes, drawBirds, drawHUD } from './renderers';

/**
 * FlappyDemo — main orchestrator for the Flappy Bird neuro-evolution frame.
 *
 * Responsibilities:
 * - Owns WASM lifecycle via useFlappyWasm
 * - Owns physics via useFlappyGameLoop
 * - Drives the imperative canvas render loop via requestAnimationFrame
 * - Composes all sub-components (stats, controls, network viz, fitness chart)
 *
 * Separation of concerns:
 * - All mutable simulation state lives in refs (no frame-rate React state)
 * - Only aggregated stats (generation, alive, score, best) flow through useState
 * - Canvas rendering is 100% imperative — never triggers React re-renders
 */
export const FlappyDemo: React.FC = () => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rafRef = useRef<number | null>(null);
    const isLoopActive = useRef(false);

    const [isPlaying, setIsPlaying] = useState(false);
    const [stats, setStats] = useState<FlappyStats>({
        score: 0,
        generation: 1,
        best: 0,
        alive: 0,
    });
    const [performanceHistory, setPerformanceHistory] = useState<PerformanceData[]>([]);
    // Stable fitness array for the network viz — updated every generation end
    const fitnessRef = useRef<Float32Array>(new Float32Array(FLAPPY_POPULATION_SIZE));

    // WASM — isolated population for Flappy Bird
    const { population, initFlappyWasm, computeFlappy, evolveFlappy } = useFlappyWasm();

    /** Called by useFlappyGameLoop after every generation to record chart data. */
    const handleGenerationEnd = useCallback(
        (maxFitness: number, avgFitness: number) => {
            setPerformanceHistory(prev => {
                const nextGen = prev.length > 0 ? prev[prev.length - 1].generation + 1 : 1;
                const updated = [...prev, { generation: nextGen, max: maxFitness, avg: avgFitness }];
                return updated.slice(-60); // keep last 60 generations
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
            evolveFlappy(fitnessScores, rate, scale, strategy);
        },
        [evolveFlappy],
    );

    const { gameState, resetFlappy, updateFlappyPhysics } = useFlappyGameLoop({
        computeFlappy,
        evolve: evolveWithTracking,
        setStats,
        mutationRate: FLAPPY_EVOLUTION_CONFIG.mutationRate,
        mutationScale: FLAPPY_EVOLUTION_CONFIG.mutationScale,
        mutationStrategy: FLAPPY_EVOLUTION_CONFIG.mutationStrategy,
        onGenerationEnd: handleGenerationEnd,
    });

    // ── Init WASM and seed birds ──────────────────────────────────────────────
    useEffect(() => {
        if (!population) {
            initFlappyWasm().then(() => {
                resetFlappy();
                setStats(s => ({ ...s, alive: FLAPPY_POPULATION_SIZE }));
            });
        }
    }, [initFlappyWasm, population, resetFlappy]);

    // ── Canvas render (imperative — no React state involved) ──────────────────
    const render = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const state = gameState.current;
        const isDark =
            document.documentElement.getAttribute('data-theme') !== 'light' &&
            !document.documentElement.classList.contains('light');

        drawBackground(ctx, isDark);
        drawPipes(ctx, state.pipes);
        drawBirds(ctx, state.birds, isDark);
        drawHUD(ctx, state.generation, state.score, state.birds.filter(b => !b.dead).length);
    }, [gameState]);

    // ── Game loop ─────────────────────────────────────────────────────────────
    const gameLoop = useCallback(() => {
        if (!isPlaying) {
            isLoopActive.current = false;
            return;
        }
        updateFlappyPhysics();
        render();
        rafRef.current = requestAnimationFrame(gameLoop);
    }, [isPlaying, updateFlappyPhysics, render]);

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
        resetFlappy();
        setStats({ score: 0, generation: 1, best: 0, alive: FLAPPY_POPULATION_SIZE });
        setPerformanceHistory([]);
        fitnessRef.current = new Float32Array(FLAPPY_POPULATION_SIZE);
    }, [resetFlappy]);

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
                <h2 className="text-2xl font-black bg-gradient-to-br from-emerald-400 to-cyan-400 bg-clip-text text-transparent uppercase tracking-[0.3em]">
                    Flappy Bird RL
                </h2>
                <p className="text-[9px] text-muted-foreground uppercase tracking-[0.3em] mt-2 font-bold">
                    Neuro-Evolution · {FLAPPY_POPULATION_SIZE} Agents · Client-Side WASM
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
                        <FlappyNetworkViz
                            population={population}
                            fitnessScores={fitnessRef.current}
                        />

                        {/* Input legend */}
                        <div className="mt-5 space-y-1.5 border-t border-border pt-4">
                            <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
                                Input Schema
                            </p>
                            {[
                                ['I₁', 'dy_top', 'Distance to top pipe gap'],
                                ['I₂', 'dy_bot', 'Distance to bottom pipe gap'],
                                ['I₃', 'bird_y', 'Bird vertical position (norm)'],
                                ['I₄', 'vy', 'Vertical velocity (norm)'],
                                ['I₅', 'dummy', 'Unused (WASM compat)'],
                            ].map(([id, name, desc]) => (
                                <div key={id} className="flex items-start gap-2">
                                    <span className="text-[8px] font-mono text-emerald-500 w-5 flex-shrink-0 pt-px">
                                        {id}
                                    </span>
                                    <div>
                                        <span className="text-[8px] font-bold text-foreground/70 font-mono">
                                            {name}
                                        </span>
                                        <p className="text-[7px] text-muted-foreground leading-tight">
                                            {desc}
                                        </p>
                                    </div>
                                </div>
                            ))}
                            <div className="mt-3 pt-3 border-t border-border">
                                <p className="text-[8px] text-muted-foreground">
                                    <span className="text-emerald-500 font-mono font-bold">out &gt; 0.5</span>
                                    {' '}→ jump
                                </p>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Centre — canvas + stats + controls + chart */}
                <div className="flex flex-col items-center flex-shrink-0">
                    <FlappyStatsBar stats={stats} />
                    <FlappyCanvas
                        ref={canvasRef}
                        width={FLAPPY_WIDTH}
                        height={FLAPPY_HEIGHT}
                    />
                    <FlappyControls
                        isPlaying={isPlaying}
                        onTogglePlay={() => setIsPlaying(p => !p)}
                        onReset={handleReset}
                    />
                    <div className="w-full mt-8">
                        <FlappyFitnessChart data={performanceHistory} />
                    </div>
                </div>

                {/* Right panel — mutation info */}
                <div className="flex flex-col gap-6 flex-shrink-0 w-80">
                    <div className="bg-card/50 border border-border rounded-2xl overflow-hidden backdrop-blur-md">
                        <div className="p-4 border-b border-border bg-card/80">
                            <h3 className="text-sm font-bold text-foreground uppercase tracking-tighter">
                                Evolution Config
                            </h3>
                            <p className="text-[9px] text-muted-foreground font-mono mt-0.5">
                                NEURAL_CALCULUS_MODIFIER
                            </p>
                        </div>
                        <div className="p-5 space-y-5">
                            {/* Strategy */}
                            <div className="space-y-2">
                                <label className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground block">
                                    Mutation Strategy
                                </label>
                                <div className="flex items-center gap-2 px-3 py-2 bg-emerald-500/10 border border-emerald-500/30 rounded-lg">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]" />
                                    <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider">
                                        Additive
                                    </span>
                                </div>
                                <div className="bg-emerald-500/5 border border-emerald-500/10 p-3 rounded-lg mt-2">
                                    <p className="text-[9px] font-mono text-emerald-500/80 mb-1">
                                        w_next = w + random(-s, s)
                                    </p>
                                    <p className="text-[8px] text-muted-foreground italic">
                                        Refinamento local — mantém a base do conhecimento.
                                    </p>
                                </div>
                            </div>

                            {/* Rates */}
                            <div className="space-y-3 pt-2 border-t border-border">
                                <div className="flex justify-between items-center">
                                    <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
                                        Mutation Rate
                                    </span>
                                    <span className="text-sm font-mono font-bold text-emerald-500">
                                        {(FLAPPY_EVOLUTION_CONFIG.mutationRate * 100).toFixed(0)}%
                                    </span>
                                </div>
                                <div className="flex justify-between items-center">
                                    <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
                                        Mutation Scale
                                    </span>
                                    <span className="text-sm font-mono font-bold text-emerald-500">
                                        {FLAPPY_EVOLUTION_CONFIG.mutationScale.toFixed(2)}
                                    </span>
                                </div>
                                <div className="flex justify-between items-center">
                                    <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
                                        Population
                                    </span>
                                    <span className="text-sm font-mono font-bold text-foreground/70">
                                        {FLAPPY_POPULATION_SIZE}
                                    </span>
                                </div>
                                <div className="flex justify-between items-center">
                                    <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
                                        Network
                                    </span>
                                    <span className="text-sm font-mono font-bold text-foreground/70">
                                        5 → 8 → 1
                                    </span>
                                </div>
                            </div>

                            {/* RL info */}
                            <div className="space-y-2 pt-2 border-t border-border">
                                <label className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground block">
                                    Reward Function
                                </label>
                                <div className="space-y-1.5">
                                    {[
                                        ['+1', 'Per frame survived'],
                                        ['+50', 'Per pipe passed'],
                                        ['0', 'On collision / floor'],
                                    ].map(([reward, desc]) => (
                                        <div key={reward} className="flex items-center gap-2">
                                            <span
                                                className={`text-[9px] font-mono font-bold w-8 text-right ${reward.startsWith('+')
                                                        ? 'text-emerald-500'
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
                            STRATEGY_PRIX_v2 • FLAPPY_RL_ACTIVE
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
