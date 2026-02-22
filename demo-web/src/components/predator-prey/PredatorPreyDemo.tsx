import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
    PREDATOR_PREY_WIDTH,
    PREDATOR_PREY_HEIGHT,
    PREDATOR_POPULATION_SIZE,
    PREY_POPULATION_SIZE,
    PREDATOR_SIZE,
    PREY_SIZE,
    PredatorPreyStats,
} from '../../types';
import { useSimulation } from '../../hooks/useSimulation';
import { predatorPreySimulationConfig, PredatorPreySimulationState } from '../../demos/predator-prey/predatorPreySimulation';

import { PredatorPreyCanvas } from './PredatorPreyCanvas';
import { PredatorPreyStatsBar } from './PredatorPreyStatsBar';
import { PredatorPreyControls } from './PredatorPreyControls';
import { PredatorPreyFitnessChart } from './PredatorPreyFitnessChart';
import { PredatorPreyNetworkViz } from './PredatorPreyNetworkViz';



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
    const rafId = useRef<number | null>(null);
    const isLoopActive = useRef(false);

    const [isPlaying, setIsPlaying] = useState(false);

    // Unified Simulation Engine (Co-Evolution)
    const { internalState, stats, performanceHistory, isReady, reset, engine, update } = useSimulation<any, PredatorPreySimulationState, PredatorPreyStats>(predatorPreySimulationConfig);

    const handleReset = useCallback(() => {
        setIsPlaying(false);
        reset();
    }, [reset]);

    // ── Canvas render ─────────────────────────────────────────────────────────
    const render = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const state = internalState.current;
        if (!state) return;

        const isDark = document.documentElement.getAttribute('data-theme') !== 'light' && !document.documentElement.classList.contains('light');

        drawBackground(ctx, isDark);
        
        const prey = state.agents.filter(a => a.popId === 'prey');
        const predators = state.agents.filter(a => a.popId === 'predators');
        
        drawAgents(ctx, prey, PREY_SIZE, isDark);
        drawAgents(ctx, predators, PREDATOR_SIZE, isDark);
        drawHUD(ctx, state.generation, predators.filter(p => !p.dead).length, prey.filter(p => !p.dead).length);
    }, [internalState]);

    const gameLoop = useCallback(() => {
        if (!isPlaying) {
            isLoopActive.current = false;
            return;
        }
        update();
        render();
        rafId.current = requestAnimationFrame(gameLoop);
    }, [isPlaying, update, render]);

    useEffect(() => {
        if (isPlaying && !isLoopActive.current && isReady) {
            isLoopActive.current = true;
            rafId.current = requestAnimationFrame(gameLoop);
        }
        return () => {
            if (rafId.current != null) cancelAnimationFrame(rafId.current);
            isLoopActive.current = false;
        };
    }, [isPlaying, gameLoop, isReady]);

    // ── Loading guard ─────────────────────────────────────────────────────────
    if (!isReady || !internalState.current) {
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
                <div className="hidden lg:flex flex-col gap-8 w-72 mt-20">
                    <PredatorPreyNetworkViz
                        predatorPopulation={engine?.populations.get('predators') || null}
                        predatorFitness={engine?.fitnessScores.get('predators')}
                        preyPopulation={engine?.populations.get('prey') || null}
                        preyFitness={engine?.fitnessScores.get('prey')}
                    />
                </div>

                <div className="flex flex-col items-center w-full max-w-[800px]">
                    <PredatorPreyStatsBar stats={stats || { generation: 1, predatorBest: 0, preyBest: 0, predatorsAlive: 0, preyAlive: 0 }} />
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
                </div>
            </div>
        </div>
    );
};
