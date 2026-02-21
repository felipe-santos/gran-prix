import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as wasm from '../../wasm/pkg/gran_prix_wasm';

import {
    PREDATOR_PREY_WIDTH,
    PREDATOR_PREY_HEIGHT,
    PREDATOR_POPULATION_SIZE,
    PREY_POPULATION_SIZE,
    PREDATOR_SIZE,
    PREY_SIZE,
    PREDATOR_INPUTS,
    PREDATOR_HIDDEN,
    PREDATOR_OUTPUTS,
    PREY_INPUTS,
    PREY_HIDDEN,
    PREY_OUTPUTS,
    PredatorPreyStats,
} from '../../types';
import { PerformanceData } from '../PerformanceCharts';
import { usePredatorWasm } from '../../hooks/usePredatorWasm';
import { usePreyWasm } from '../../hooks/usePreyWasm';
import { usePredatorPreyGameLoop } from '../../hooks/usePredatorPreyGameLoop';

import { PredatorPreyCanvas } from './PredatorPreyCanvas';
import { PredatorPreyStatsBar } from './PredatorPreyStatsBar';
import { PredatorPreyControls } from './PredatorPreyControls';
import { PredatorPreyFitnessChart } from './PredatorPreyFitnessChart';
import { PredatorPreyNetworkViz } from './PredatorPreyNetworkViz';

const DEFAULT_MUTATION_RATE = 0.15;
const DEFAULT_MUTATION_SCALE = 0.4;

// ── Canvas render helpers ─────────────────────────────────────────────────────

function drawBackground(ctx: CanvasRenderingContext2D, isDark: boolean): void {
    const trailColor = isDark ? 'rgba(8, 8, 12, 0.7)' : 'rgba(248, 248, 249, 0.7)';
    ctx.fillStyle = trailColor;
    ctx.fillRect(0, 0, PREDATOR_PREY_WIDTH, PREDATOR_PREY_HEIGHT);

    const gridColor = isDark ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.025)';
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;

    for (let x = 0; x < PREDATOR_PREY_WIDTH; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0); ctx.lineTo(x, PREDATOR_PREY_HEIGHT);
        ctx.stroke();
    }
    for (let y = 0; y < PREDATOR_PREY_HEIGHT; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y); ctx.lineTo(PREDATOR_PREY_WIDTH, y);
        ctx.stroke();
    }
}

function drawAgents(
    ctx: CanvasRenderingContext2D,
    agents: { x: number; y: number; dead: boolean; color: string }[],
    size: number,
    isDark: boolean,
) {
    agents.forEach(agent => {
        if (agent.dead) {
            ctx.globalAlpha = isDark ? 0.08 : 0.12;
            ctx.fillStyle = isDark ? '#333' : '#ccc';
        } else {
            ctx.globalAlpha = 0.92;
            ctx.fillStyle = agent.color;
        }

        ctx.beginPath();
        ctx.ellipse(agent.x, agent.y, size / 2, size / 2, 0, 0, Math.PI * 2);
        ctx.fill();
    });
    ctx.globalAlpha = 1.0;
}

function drawHUD(
    ctx: CanvasRenderingContext2D,
    generation: number,
    predatorsAlive: number,
    preyAlive: number,
): void {
    ctx.font = 'bold 11px Inter, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(16, 185, 129, 0.85)';
    ctx.textAlign = 'left';
    ctx.fillText(`GEN ${generation}`, 12, 20);

    ctx.fillStyle = 'rgba(244, 63, 94, 0.8)'; // rose-500
    ctx.fillText(`FOXES ${predatorsAlive}`, 12, 36);
    
    ctx.fillStyle = 'rgba(96, 165, 250, 0.8)'; // blue-400
    ctx.fillText(`RABBITS ${preyAlive}`, 12, 52);
}

// ─────────────────────────────────────────────────────────────────────────────

export const PredatorPreyDemo: React.FC = () => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rafRef = useRef<number | null>(null);
    const isLoopActive = useRef(false);

    const [isPlaying, setIsPlaying] = useState(false);
    const [stats, setStats] = useState<PredatorPreyStats>({
        predatorsAlive: 0,
        preyAlive: 0,
        generation: 1,
        predatorBest: 0,
        preyBest: 0
    });
    const [performanceHistory, setPerformanceHistory] = useState<PerformanceData[]>([]);

    const { predatorPopulation, initPredatorWasm, computePredator, evolvePredator } = usePredatorWasm();
    const { preyPopulation, initPreyWasm, computePrey, evolvePrey } = usePreyWasm();

    const handleGenerationEnd = useCallback(
        (predMax: number, predAvg: number, _preyMax: number, _preyAvg: number) => {
            setPerformanceHistory(prev => {
                const nextGen = prev.length > 0 ? prev[prev.length - 1].generation + 1 : 1;
                // Currently PerformanceCharts supports single max/avg series
                // We'll plot the predator's curve for the main graph for visibility, 
                // but one could extend PerformanceData to support multiple series.
                const updated = [...prev, { generation: nextGen, max: predMax, avg: predAvg }];
                return updated.slice(-60);
            });
        },
        [],
    );

    const { gameState, resetSimulation, updatePhysics } = usePredatorPreyGameLoop({
        computePredator,
        computePrey,
        evolvePredator,
        evolvePrey,
        setStats,
        mutationRate: DEFAULT_MUTATION_RATE,
        mutationScale: DEFAULT_MUTATION_SCALE,
        mutationStrategy: wasm.MutationStrategy.Additive,
        onGenerationEnd: handleGenerationEnd,
    });

    // ── Init WASM ─────────────────────────────────────────────────────────────
    useEffect(() => {
        if (!predatorPopulation || !preyPopulation) {
            Promise.all([initPredatorWasm(), initPreyWasm()]).then(() => {
                resetSimulation();
            });
        }
    }, [initPredatorWasm, initPreyWasm, predatorPopulation, preyPopulation, resetSimulation]);

    // ── Canvas render ─────────────────────────────────────────────────────────
    const render = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const state = gameState.current;
        const isDark = document.documentElement.getAttribute('data-theme') !== 'light' && !document.documentElement.classList.contains('light');

        drawBackground(ctx, isDark);
        drawAgents(ctx, state.prey, PREY_SIZE, isDark);
        drawAgents(ctx, state.predators, PREDATOR_SIZE, isDark);
        drawHUD(ctx, state.generation, state.predators.filter(p => !p.dead).length, state.prey.filter(p => !p.dead).length);
    }, [gameState]);

    // ── Game loop ─────────────────────────────────────────────────────────────
    const gameLoop = useCallback(() => {
        if (!isPlaying) {
            isLoopActive.current = false;
            return;
        }
        updatePhysics();
        render();
        rafRef.current = requestAnimationFrame(gameLoop);
    }, [isPlaying, updatePhysics, render]);

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

    const handleReset = useCallback(() => {
        setIsPlaying(false);
        resetSimulation();
        setPerformanceHistory([]);
    }, [resetSimulation]);

    // ── Loading guard ─────────────────────────────────────────────────────────
    if (!predatorPopulation || !preyPopulation) {
        return (
            <div className="w-full flex flex-col items-center justify-center py-24 gap-4">
                <div className="w-12 h-12 border-4 border-rose-500/20 border-t-rose-500 rounded-full animate-spin" />
                <span className="text-[10px] uppercase font-black tracking-[0.3em] text-rose-500">
                    Initializing Multi-Agent WASM...
                </span>
            </div>
        );
    }

    return (
        <div className="w-full flex flex-col items-center gap-0">
            <div className="flex flex-col items-center mb-8">
                <h2 className="text-2xl font-black bg-gradient-to-br from-rose-400 to-orange-400 bg-clip-text text-transparent uppercase tracking-[0.3em]">
                    Predator vs Prey
                </h2>
                <p className="text-[9px] text-muted-foreground uppercase tracking-[0.3em] mt-2 font-bold">
                    Co-Evolution Engine · {PREDATOR_POPULATION_SIZE} Foxes vs {PREY_POPULATION_SIZE} Rabbits
                </p>
            </div>

            <div className="w-full max-w-[1400px] flex flex-col lg:flex-row items-center lg:items-start justify-center gap-8">
                {/* ── Left Panel: Predator Brain ── */}
                <div className="hidden lg:flex flex-col gap-8 w-72 mt-20">
                    <PredatorPreyNetworkViz
                        population={predatorPopulation}
                        fitnessScores={Float32Array.from(gameState.current.predators.map(p => p.fitness))}
                        inputSize={PREDATOR_INPUTS}
                        hiddenSize={PREDATOR_HIDDEN}
                        outputSize={PREDATOR_OUTPUTS}
                        title="Fox Brain"
                        themeColor="text-rose-500"
                        nodeColor="rgba(244, 63, 94, 0.6)"
                    />
                </div>

                <div className="flex flex-col items-center w-full max-w-[800px]">
                    <PredatorPreyStatsBar stats={stats} />
                    <PredatorPreyCanvas
                        ref={canvasRef}
                        width={PREDATOR_PREY_WIDTH}
                        height={PREDATOR_PREY_HEIGHT}
                    />
                    <PredatorPreyControls
                        isPlaying={isPlaying}
                        onTogglePlay={() => setIsPlaying(p => !p)}
                        onReset={handleReset}
                    />
                    <div className="w-full max-w-5xl mt-8">
                        <PredatorPreyFitnessChart data={performanceHistory} />
                    </div>
                </div>

                {/* ── Right Panel: Prey Brain ── */}
                <div className="hidden lg:flex flex-col gap-8 w-72 mt-20">
                    <PredatorPreyNetworkViz
                        population={preyPopulation}
                        fitnessScores={Float32Array.from(gameState.current.prey.map(p => p.fitness))}
                        inputSize={PREY_INPUTS}
                        hiddenSize={PREY_HIDDEN}
                        outputSize={PREY_OUTPUTS}
                        title="Rabbit Brain"
                        themeColor="text-blue-400"
                        nodeColor="rgba(96, 165, 250, 0.6)"
                    />
                </div>
            </div>
        </div>
    );
};
