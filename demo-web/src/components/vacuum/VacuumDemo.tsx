import { useEffect, useRef, useState, useCallback } from 'react';
import * as wasm from '../../wasm/pkg/gran_prix_wasm';

import {
    VACUUM_WIDTH,
    VACUUM_HEIGHT,
    VACUUM_SIZE,
    VACUUM_POPULATION_SIZE,
    VACUUM_INPUTS,
    VACUUM_HIDDEN,
    VACUUM_OUTPUTS,
    VACUUM_MAX_FRAMES,
    VacuumStats,
} from '../../types/vacuum';
import { PerformanceData } from '../../types/common';
import { PerformanceCharts } from '../PerformanceCharts';
import { useVacuumWasm } from '../../hooks/useVacuumWasm';
import { useVacuumGameLoop } from '../../hooks/useVacuumGameLoop';

import { VacuumCanvas } from './VacuumCanvas';
import { VacuumStatsBar } from './VacuumStatsBar';
import { VacuumNetworkViz } from './VacuumNetworkViz';
import { GameControls } from '../GameControls';
import {
    drawFloor,
    drawDust,
    drawObstacles,
    drawCharger,
    drawVacuumAgent,
    drawMiniDustMap,
    drawHUD,
} from './renderers';
import {
    VACUUM_EVOLUTION_CONFIG,
    VACUUM_SIMULATION_CONFIG,
} from '../../config/vacuum.config';

// ─── Main Component ────────────────────────────────────────────────────────────
// NOTE: All rendering helpers have been extracted to ./renderers/ for better
// modularity and reusability. See ./renderers/index.ts for the full list.

export function VacuumDemo() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [stats, setStats] = useState<VacuumStats>({ generation: 1, best: 0, avgCleaned: 0, alive: 0 });
    const [performanceHistory, setPerformanceHistory] = useState<PerformanceData[]>([]);
    const fitnessRef = useRef<Float32Array>(new Float32Array(VACUUM_POPULATION_SIZE));

    const { population, initVacuumWasm, computeVacuum, evolveVacuum } = useVacuumWasm();

    const evolve = useCallback((
        fitnessScores: number[], rate: number, scale: number, strategy: wasm.MutationStrategy,
    ) => {
        fitnessRef.current = Float32Array.from(fitnessScores);
        evolveVacuum(fitnessScores, rate, scale, strategy);
    }, [evolveVacuum]);

    const onGenerationEnd = useCallback((maxFitness: number, avgFitness: number) => {
        setPerformanceHistory(prev => {
            const nextGen = prev.length > 0 ? prev[prev.length - 1].generation + 1 : 1;
            const newHistory = [...prev, { generation: nextGen, avg: avgFitness, max: maxFitness }];
            return newHistory.slice(-60);
        });
    }, []);

    const { gameState, resetVacuum, updatePhysics } = useVacuumGameLoop({
        computeVacuum, evolve, setStats,
        mutationRate: VACUUM_EVOLUTION_CONFIG.mutationRate,
        mutationScale: VACUUM_EVOLUTION_CONFIG.mutationScale,
        mutationStrategy: VACUUM_EVOLUTION_CONFIG.mutationStrategy,
        onGenerationEnd,
    });

    useEffect(() => {
        if (!population) {
            initVacuumWasm().then(() => resetVacuum());
        }
    }, [initVacuumWasm, population, resetVacuum]);


    const render = useCallback((ctx: CanvasRenderingContext2D) => {
        const state = gameState.current;
        const { env, agents, frame } = state;

        drawFloor(ctx);
        
        const sorted = [...agents].filter(a => !a.dead).sort((a, b) => b.fitness - a.fitness);
        const topAgents = sorted.slice(0, 10);
        
        drawDust(ctx, env.dustMap, env.cols, env.rows);
        drawObstacles(ctx, env.obstacles);
        drawCharger(ctx, env.chargerX, env.chargerY, frame);


        for (const agent of sorted.slice(10)) {
            drawVacuumAgent(ctx, agent.x, agent.y, agent.heading, agent.battery, agent.color, false, false);
        }
        for (let i = topAgents.length - 1; i >= 0; i--) {
            drawVacuumAgent(ctx, topAgents[i].x, topAgents[i].y, topAgents[i].heading, topAgents[i].battery, topAgents[i].color, true, i === 0);
        }
        for (const agent of agents.filter(a => a.dead)) {
            ctx.globalAlpha = 0.15;
            ctx.fillStyle = '#666';
            ctx.beginPath();
            ctx.arc(agent.x, agent.y, VACUUM_SIZE * 0.5, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1.0;

        drawMiniDustMap(ctx, env.dustMap, env.cols, env.rows, VACUUM_WIDTH - 180, 60, 170, 120);
        drawHUD(ctx, state.generation, frame, sorted.length, topAgents[0] || null, env.totalDust);
    }, [gameState]);

    // Game loop
    const rafId = useRef<number | null>(null);
    const isLoopActive = useRef(false);

    const gameLoop = useCallback(() => {
        if (!isPlaying) { isLoopActive.current = false; return; }
        if (!canvasRef.current) { rafId.current = requestAnimationFrame(gameLoop); return; }
        const ctx = canvasRef.current.getContext('2d');
        if (!ctx) return;
        for (let i = 0; i < VACUUM_SIMULATION_CONFIG.physicsSpeed; i++) updatePhysics();
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
        resetVacuum();
        setStats({ generation: 1, best: 0, avgCleaned: 0, alive: 0 });
        setPerformanceHistory([]);
        fitnessRef.current = new Float32Array(VACUUM_POPULATION_SIZE);
    }, [resetVacuum]);

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

    const currentDustRemaining = gameState.current?.env?.dustMap?.filter(d => d).length || 0;
    const totalDust = gameState.current?.env?.totalDust || 0;
    const dustProgress = totalDust > 0 ? 1 - (currentDustRemaining / totalDust) : 0;
    const bestBattery = gameState.current?.agents?.filter(a => !a.dead).sort((a, b) => b.fitness - a.fitness)[0]?.battery ?? 0;

    return (
        <div className="w-full flex flex-col items-center gap-0">
            {/* ── Header ──────────────────────────────────────────────────────── */}
            <div className="flex flex-col items-center mb-8">
                <h2 className="text-2xl font-black bg-gradient-to-br from-cyan-400 to-emerald-400 bg-clip-text text-transparent uppercase tracking-[0.3em]">
                    Smart Vacuum
                </h2>
                <p className="text-[9px] text-muted-foreground uppercase tracking-[0.3em] mt-2 font-bold">
                    Autonomous Navigation · {VACUUM_POPULATION_SIZE} Agents · Dust Sensing · Battery Management
                </p>
            </div>

            {/* ── Main layout: left panel | canvas | right panel ───────────── */}
            <div className="w-full max-w-7xl flex flex-col lg:flex-row items-center lg:items-start justify-center gap-8">

                {/* Left panel — Brain Inspector + Input Schema */}
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
                        <VacuumNetworkViz population={population} fitnessScores={fitnessRef.current} />

                        {/* Input legend */}
                        <div className="mt-5 space-y-1.5 border-t border-border pt-4">
                            <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
                                Input Schema (9 sensors)
                            </p>
                            {[
                                ['I₁', 'dust_fwd', 'Dust density ahead (raycasted)'],
                                ['I₂', 'dust_left', 'Dust density ≈60° left'],
                                ['I₃', 'dust_right', 'Dust density ≈60° right'],
                                ['I₄', 'obs_fwd', 'Obstacle distance ahead (1=far)'],
                                ['I₅', 'battery', 'Current charge level [0..1]'],
                                ['I₆', 'dist_⚡', 'Distance to charging station'],
                                ['I₇', 'ang_⚡', 'Angle to charger vs heading'],
                                ['I₈', 'sin(θ)', 'Heading cyclic encoding (sin)'],
                                ['I₉', 'cos(θ)', 'Heading cyclic encoding (cos)'],
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
                                    <span className="text-cyan-400 font-mono font-bold">3 outputs</span>
                                    {' '}→ forward, turn_left, turn_right [0, 1]
                                </p>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Centre — canvas + stats + controls + chart */}
                <div className="flex flex-col items-center flex-shrink-0">
                    <VacuumStatsBar
                        stats={stats}
                        battery={bestBattery}
                        dustProgress={dustProgress}
                        frame={gameState.current.frame}
                    />
                    <VacuumCanvas ref={canvasRef} />
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
                                Evolution Config
                            </h3>
                            <p className="text-[9px] text-muted-foreground font-mono mt-0.5">
                                VACUUM_NAV_PROTOCOL
                            </p>
                        </div>
                        <div className="p-5 space-y-5">
                            {/* Strategy */}
                            <div className="space-y-2">
                                <label className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground block">
                                    Mutation Strategy
                                </label>
                                <div className="flex items-center gap-2 px-3 py-2 bg-cyan-500/10 border border-cyan-500/30 rounded-lg">
                                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-500 shadow-[0_0_6px_rgba(6,182,212,0.5)]" />
                                    <span className="text-[10px] font-bold text-cyan-400 uppercase tracking-wider">
                                        Additive
                                    </span>
                                </div>
                                <div className="bg-cyan-500/5 border border-cyan-500/10 p-3 rounded-lg mt-2">
                                    <p className="text-[9px] font-mono text-cyan-500/80 mb-1">
                                        w_next = w + random(-s, s)
                                    </p>
                                    <p className="text-[8px] text-muted-foreground italic">
                                        Refinamento local — preserva estratégias de navegação aprendidas.
                                    </p>
                                </div>
                            </div>

                            {/* Rates */}
                            <div className="space-y-3 pt-2 border-t border-border">
                                {[
                                    ['Mutation Rate', `${(VACUUM_EVOLUTION_CONFIG.mutationRate * 100).toFixed(0)}%`, true],
                                    ['Mutation Scale', VACUUM_EVOLUTION_CONFIG.mutationScale.toFixed(2), true],
                                    ['Population', `${VACUUM_POPULATION_SIZE}`, false],
                                    ['Network', `${VACUUM_INPUTS} → ${VACUUM_HIDDEN} → ${VACUUM_OUTPUTS}`, false],
                                    ['Gen Length', `${VACUUM_MAX_FRAMES} frames`, false],
                                    ['Sensor Range', '4 cells (raycasted)', false],
                                    ['Battery Cap', '1.0 (100%)', false],
                                ].map(([label, value, accent]) => (
                                    <div key={label as string} className="flex justify-between items-center">
                                        <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
                                            {label}
                                        </span>
                                        <span className={`text-sm font-mono font-bold ${accent ? 'text-cyan-400' : 'text-foreground/70'}`}>
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
                                        ['+10×r', 'Dust cleaned ratio (r = cleaned / total)'],
                                        ['+2.0', 'Battery bonus (returned to charger >10%)'],
                                        ['-0.02/h', 'Wall/obstacle collision penalty (h = hits)'],
                                        ['-3.0', 'Death penalty (battery empty away from charger)'],
                                    ].map(([reward, desc]) => (
                                        <div key={reward} className="flex items-center gap-2">
                                            <span
                                                className={`text-[9px] font-mono font-bold w-12 text-right ${(reward as string).startsWith('+')
                                                    ? 'text-cyan-400'
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

                            {/* Environment details */}
                            <div className="space-y-2 pt-2 border-t border-border">
                                <label className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground block">
                                    Environment
                                </label>
                                <div className="space-y-1">
                                    {[
                                        ['🏠', 'Room', `${VACUUM_WIDTH}×${VACUUM_HEIGHT}px grid`],
                                        ['🧹', 'Dust', '~55% coverage + random clusters'],
                                        ['🪑', 'Obstacles', '5 furniture pieces (collision)'],
                                        ['⚡', 'Charger', 'Bottom-left, recharges at 1%/frame'],
                                        ['🔋', 'Battery', 'Move=-0.08%, Clean=-0.04%'],
                                    ].map(([icon, label, desc]) => (
                                        <div key={label} className="flex items-center gap-2">
                                            <span className="text-[10px] w-5 text-center">{icon}</span>
                                            <span className="text-[8px] font-bold text-foreground/70 w-14">{label}</span>
                                            <span className="text-[7px] text-muted-foreground">{desc}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>

                        <div className="p-3 bg-muted/50 border-t border-border text-[8px] text-muted-foreground font-mono text-center tracking-widest">
                            STRATEGY_PRIX_v2 • SMART_VACUUM_ACTIVE
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
