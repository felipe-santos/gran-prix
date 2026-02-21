import { useEffect, useRef, useState, useCallback } from 'react';
import * as wasm from '../../wasm/pkg/gran_prix_wasm';

import {
    VACUUM_WIDTH,
    VACUUM_HEIGHT,
    VACUUM_SIZE,
    VACUUM_CELL_SIZE,
    VACUUM_POPULATION_SIZE,
    VACUUM_INPUTS,
    VACUUM_HIDDEN,
    VACUUM_OUTPUTS,
    VACUUM_MAX_FRAMES,
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
    const grad = ctx.createLinearGradient(0, 0, 0, VACUUM_HEIGHT);
    grad.addColorStop(0, '#2a2218');
    grad.addColorStop(1, '#1e1a14');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, VACUUM_WIDTH, VACUUM_HEIGHT);

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

    ctx.strokeStyle = '#5a4a3a';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, VACUUM_WIDTH - 4, VACUUM_HEIGHT - 4);
}

function drawDust(ctx: CanvasRenderingContext2D, dustMap: boolean[], cols: number, rows: number) {
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            if (dustMap[row * cols + col]) {
                const x = col * VACUUM_CELL_SIZE;
                const y = row * VACUUM_CELL_SIZE;
                ctx.fillStyle = 'rgba(180, 160, 130, 0.35)';
                ctx.beginPath();
                ctx.arc(x + VACUUM_CELL_SIZE * 0.5, y + VACUUM_CELL_SIZE * 0.5, VACUUM_CELL_SIZE * 0.3, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = 'rgba(160, 140, 110, 0.25)';
                ctx.beginPath();
                ctx.arc(x + VACUUM_CELL_SIZE * 0.3, y + VACUUM_CELL_SIZE * 0.35, 2, 0, Math.PI * 2);
                ctx.fill();
                ctx.beginPath();
                ctx.arc(x + VACUUM_CELL_SIZE * 0.7, y + VACUUM_CELL_SIZE * 0.65, 1.5, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }
}

function drawObstacles(ctx: CanvasRenderingContext2D, obstacles: { x: number; y: number; w: number; h: number; label: string }[]) {
    for (const o of obstacles) {
        ctx.fillStyle = '#3a3028';
        ctx.fillRect(o.x, o.y, o.w, o.h);
        ctx.strokeStyle = '#5a4a38';
        ctx.lineWidth = 2;
        ctx.strokeRect(o.x, o.y, o.w, o.h);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
        ctx.lineWidth = 1;
        ctx.strokeRect(o.x + 4, o.y + 4, o.w - 8, o.h - 8);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.font = 'bold 8px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(o.label, o.x + o.w / 2, o.y + o.h / 2);
    }
    ctx.textBaseline = 'alphabetic';
}

function drawCharger(ctx: CanvasRenderingContext2D, x: number, y: number, frame: number) {
    const pulseAlpha = 0.3 + Math.sin(frame * 0.08) * 0.15;
    const glowGrad = ctx.createRadialGradient(x, y, 0, x, y, 35);
    glowGrad.addColorStop(0, `rgba(16, 185, 129, ${pulseAlpha})`);
    glowGrad.addColorStop(1, 'rgba(16, 185, 129, 0)');
    ctx.fillStyle = glowGrad;
    ctx.beginPath();
    ctx.arc(x, y, 35, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#1a3a2a';
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = '#10b981';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⚡', x, y);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#10b98188';
    ctx.font = 'bold 7px monospace';
    ctx.fillText('CHARGER', x, y + 28);
}

function drawVacuumAgent(
    ctx: CanvasRenderingContext2D, x: number, y: number,
    heading: number, battery: number, color: string,
    isTop: boolean, showSensors: boolean,
) {
    ctx.save();
    ctx.translate(x, y);

    ctx.globalAlpha = isTop ? 0.9 : 0.5;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, VACUUM_SIZE, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = isTop ? 0.8 : 0.3;
    const tipX = Math.cos(heading) * VACUUM_SIZE;
    const tipY = Math.sin(heading) * VACUUM_SIZE;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(Math.cos(heading + 2.5) * VACUUM_SIZE * 0.5, Math.sin(heading + 2.5) * VACUUM_SIZE * 0.5);
    ctx.lineTo(Math.cos(heading - 2.5) * VACUUM_SIZE * 0.5, Math.sin(heading - 2.5) * VACUUM_SIZE * 0.5);
    ctx.closePath();
    ctx.fill();

    if (isTop) {
        ctx.globalAlpha = 0.8;
        const barW = VACUUM_SIZE * 2;
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(-VACUUM_SIZE, VACUUM_SIZE + 4, barW, 3);
        ctx.fillStyle = battery > 0.5 ? '#10b981' : battery > 0.2 ? '#f59e0b' : '#ef4444';
        ctx.fillRect(-VACUUM_SIZE, VACUUM_SIZE + 4, barW * battery, 3);
    }

    if (showSensors) {
        ctx.globalAlpha = 0.25;
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        const sensorLen = VACUUM_CELL_SIZE * 4;
        for (const angle of [heading, heading - Math.PI / 3, heading + Math.PI / 3]) {
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

function drawMiniDustMap(ctx: CanvasRenderingContext2D, dustMap: boolean[], cols: number, rows: number, mapX: number, mapY: number, mapW: number, mapH: number) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(mapX, mapY, mapW, mapH);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.strokeRect(mapX, mapY, mapW, mapH);
    ctx.fillStyle = '#ffffff88';
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('DUST MAP', mapX + 4, mapY + 10);

    const cellW = (mapW - 8) / cols;
    const cellH = (mapH - 18) / rows;
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            ctx.fillStyle = dustMap[row * cols + col] ? 'rgba(180, 140, 80, 0.6)' : 'rgba(16, 185, 129, 0.15)';
            ctx.fillRect(mapX + 4 + col * cellW, mapY + 14 + row * cellH, cellW - 0.5, cellH - 0.5);
        }
    }
}

function drawHUD(
    ctx: CanvasRenderingContext2D, generation: number, frame: number,
    alive: number, bestAgent: { dustCleaned: number; battery: number; wallHits: number } | null,
    totalDust: number,
) {
    ctx.font = 'bold 11px Inter, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(16, 185, 129, 0.85)';
    ctx.textAlign = 'left';
    ctx.fillText(`GEN ${generation}`, 12, 20);
    ctx.fillStyle = 'rgba(200, 200, 220, 0.5)';
    ctx.fillText(`FRAME ${frame} / ${VACUUM_MAX_FRAMES}`, 12, 36);
    ctx.fillText(`ALIVE ${alive}`, 12, 52);

    if (bestAgent) {
        const pct = totalDust > 0 ? ((bestAgent.dustCleaned / totalDust) * 100).toFixed(1) : '0';
        ctx.fillStyle = 'rgba(16, 185, 129, 0.7)';
        ctx.textAlign = 'right';
        ctx.fillText(`BEST: ${pct}% cleaned`, VACUUM_WIDTH - 12, 20);
        ctx.fillStyle = bestAgent.battery > 0.3 ? 'rgba(16, 185, 129, 0.6)' : 'rgba(239, 68, 68, 0.7)';
        ctx.fillText(`🔋 ${(bestAgent.battery * 100).toFixed(0)}%`, VACUUM_WIDTH - 12, 36);
    }
}

// ─── Main Component ────────────────────────────────────────────────────────────

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
        mutationRate: DEFAULT_MUTATION_RATE,
        mutationScale: DEFAULT_MUTATION_SCALE,
        mutationStrategy: wasm.MutationStrategy.Additive,
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
        for (let i = 0; i < 4; i++) updatePhysics();
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
                                    ['Mutation Rate', `${(DEFAULT_MUTATION_RATE * 100).toFixed(0)}%`, true],
                                    ['Mutation Scale', DEFAULT_MUTATION_SCALE.toFixed(2), true],
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
