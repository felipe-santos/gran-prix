import { useEffect, useRef, useState, useCallback } from 'react';

import {
    VacuumStats,
} from '../../types/vacuum';
import { PerformanceCharts } from '../PerformanceCharts';
import { useSimulation } from '../../hooks/useSimulation';
import { vacuumSimulationConfig, VacuumSimulationState, VacuumAgent } from '../../demos/vacuum/vacuumSimulation';

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
    drawHUD,
} from './renderers';

export function VacuumDemo() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rafRef = useRef<number | null>(null);
    const isLoopActive = useRef(false);

    const [isPlaying, setIsPlaying] = useState(false);
    
    // Unified Simulation Engine
    const { internalState, stats, performanceHistory, isReady, update, reset, engine } = useSimulation<VacuumAgent, VacuumSimulationState, VacuumStats>(vacuumSimulationConfig);

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

        const sortedAgents = [...state.agents].sort((a, b) => b.fitness - a.fitness);
        const bestAgent = sortedAgents[0];
        const bestStats = bestAgent ? {
            dustCleaned: bestAgent.dustCleaned,
            battery: bestAgent.battery,
            wallHits: bestAgent.wallHits
        } : null;

        drawHUD(ctx, state.generation, state.frame, state.agents.filter(a => !a.dead).length, bestStats, state.env.totalDust);
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

    if (!isReady || !internalState.current) {
        return (
            <div className="w-full flex flex-col items-center justify-center py-24 gap-4">
                <div className="w-12 h-12 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin" />
                <span className="text-[10px] uppercase font-black tracking-[0.3em] text-emerald-500">
                    Initializing Smart Vacuum WASM…
                </span>
            </div>
        );
    }

    const state = internalState.current!;
    const sorted = [...state.agents].sort((a, b) => b.fitness - a.fitness);
    const bestAgent = sorted[0];

    return (
        <div className="w-full flex flex-col items-center gap-0">
            <div className="flex flex-col items-center mb-8">
                <h2 className="text-2xl font-black bg-gradient-to-br from-emerald-400 to-teal-600 bg-clip-text text-transparent uppercase tracking-[0.3em]">
                    Smart Vacuum
                </h2>
                <p className="text-[9px] text-muted-foreground uppercase tracking-[0.3em] mt-2 font-bold">
                    Autonomous Navigation · Multi-Agent Swarm
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
                        <VacuumNetworkViz
                            population={(engine as any)?.populations.get('vacuums')}
                            fitnessScores={engine?.fitnessScores.get('vacuums')}
                        />
                        <div className="mt-5 space-y-1.5 border-t border-border pt-4">
                            <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
                                Inputs (8)
                            </p>
                            {[
                                ['I₁', 'battery', 'Remaining energy'],
                                ['I₂₋₄', 'dust', 'Dust sensors (L/C/R)'],
                                ['I₅', 'wall', 'Wall/Obstacle distance'],
                                ['I₆₋₈', 'base', 'Base direction & distance'],
                            ].map(([idx, name, desc]) => (
                                <div key={idx} className="flex items-start gap-2">
                                    <span className="text-[8px] font-mono text-emerald-500 w-5 flex-shrink-0 pt-px">{idx}</span>
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
                    <VacuumStatsBar 
                        stats={stats} 
                        battery={bestAgent?.battery || 0}
                        dustProgress={state.env.totalDust > 0 ? (bestAgent?.dustCleaned || 0) / state.env.totalDust : 0}
                        frame={state.frame}
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

                <div className="hidden lg:flex flex-col gap-6 flex-shrink-0 w-80">
                    <div className="bg-card/50 border border-border rounded-2xl p-6 backdrop-blur-md">
                        <h3 className="text-xs font-bold text-emerald-500 uppercase tracking-widest mb-4">
                            Training Goal
                        </h3>
                        <div className="space-y-4">
                            <p className="text-xs text-muted-foreground leading-relaxed">
                                Vacuums must navigate the room, avoid furniture, and 
                                return to the <span className="text-emerald-400 font-bold">Charging Base</span> 
                                before their battery runs out.
                            </p>
                            <div className="bg-emerald-500/5 rounded-xl p-3 border border-emerald-500/10">
                                <h4 className="text-[10px] font-bold text-emerald-400 uppercase mb-2">Fitness Rewards</h4>
                                <ul className="text-[10px] space-y-1.5 text-muted-foreground">
                                    <li className="flex items-center gap-2">
                                        <div className="w-1 h-1 rounded-full bg-emerald-500" />
                                        <span>Cleaning Dust: +100</span>
                                    </li>
                                    <li className="flex items-center gap-2">
                                        <div className="w-1 h-1 rounded-full bg-rose-500" />
                                        <span>Wall Hits: -5</span>
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
