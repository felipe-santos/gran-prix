import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
    DRONE_WIDTH,
    DRONE_HEIGHT,
    DroneStats,
} from '../../types';
import { PerformanceCharts } from '../PerformanceCharts';
import { useSimulation } from '../../hooks/useSimulation';
import { droneSimulationConfig, DroneSimulationState } from '../../demos/drone/droneSimulation';

import { DroneCanvas } from './DroneCanvas';
import { DroneStatsBar } from './DroneStatsBar';
import { GameControls } from '../GameControls';
import { DroneNetworkViz } from './DroneNetworkViz';
import {
    drawBackground,
    drawTarget,
    drawDrones,
    drawPidDrone,
    drawWindIndicator,
} from './renderers';

export const DroneDemo: React.FC = () => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rafRef = useRef<number | null>(null);
    const isLoopActive = useRef(false);

    const [isPlaying, setIsPlaying] = useState(false);
    
    // Unified Simulation Engine
    const { internalState, stats, performanceHistory, isReady, update, reset, engine } = useSimulation<any, DroneSimulationState, DroneStats>(droneSimulationConfig);

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

        const isDark =
            document.documentElement.getAttribute('data-theme') !== 'light' &&
            !document.documentElement.classList.contains('light');

        drawBackground(ctx, isDark);
        drawTarget(ctx, state.targetX, state.targetY);
        drawDrones(ctx, state.agents, isDark);
        if (state.pidDrone) {
            drawPidDrone(ctx, state.pidDrone);
        }
        drawWindIndicator(ctx, state.windX, state.windY);
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
                    Initializing Drone WASM…
                </span>
            </div>
        );
    }


    return (
        <div className="w-full flex flex-col items-center gap-0">
            <div className="flex flex-col items-center mb-8">
                <h2 className="text-2xl font-black bg-gradient-to-br from-indigo-400 to-cyan-400 bg-clip-text text-transparent uppercase tracking-[0.3em]">
                    Drone Stabilizer
                </h2>
                <p className="text-[9px] text-muted-foreground uppercase tracking-[0.3em] mt-2 font-bold">
                    PID vs Neural Network · Continuous Control
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
                        <DroneNetworkViz
                            population={(engine as any)?.populations.get('drones')}
                            fitnessScores={engine?.fitnessScores.get('drones')}
                        />
                        <div className="mt-5 space-y-1.5 border-t border-border pt-4">
                            <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
                                Inputs (4)
                            </p>
                            {[
                                ['I₁', 'distX', 'Distance to target (X)'],
                                ['I₂', 'distY', 'Distance to target (Y)'],
                                ['I₃', 'vx', 'Velocity (X)'],
                                ['I₄', 'vy', 'Velocity (Y)'],
                            ].map(([idx, name, desc]) => (
                                <div key={idx} className="flex items-start gap-2">
                                    <span className="text-[8px] font-mono text-indigo-500 w-5 flex-shrink-0 pt-px">{idx}</span>
                                    <div>
                                        <span className="text-[8px] font-bold text-foreground/70 font-mono">{name}</span>
                                        <p className="text-[7px] text-muted-foreground leading-tight">{desc}</p>
                                    </div>
                                </div>
                            ))}
                            <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground mb-2 mt-4 pt-2 border-t border-border">
                                Outputs (2) &rarr; Thrust X/Y
                            </p>
                        </div>
                    </div>
                </div>

                <div className="flex flex-col items-center flex-shrink-0">
                    <DroneStatsBar stats={stats || { generation: 1, best: 0, alive: 0, avgFitness: 0 }} />
                    <DroneCanvas ref={canvasRef} width={DRONE_WIDTH} height={DRONE_HEIGHT} />
                    <GameControls
                        isPlaying={isPlaying}
                        onTogglePlay={() => setIsPlaying(p => !p)}
                        onReset={handleReset}
                    />
                    <div className="w-full mt-8">
                        <PerformanceCharts data={performanceHistory} />
                    </div>
                </div>

                <div className="flex flex-col gap-6 flex-shrink-0 w-80">
                    <div className="bg-card/50 border border-border rounded-2xl overflow-hidden backdrop-blur-md p-6">
                        <div className="border-b border-border pb-3 mb-5">
                            <h3 className="text-sm font-bold text-orange-500 uppercase tracking-tighter">
                                PID Controller
                            </h3>
                            <p className="text-[9px] text-muted-foreground font-mono mt-0.5">
                                MATHEMATICAL REFERENCE
                            </p>
                        </div>
                        <div className="space-y-4">
                            <p className="text-xs text-muted-foreground leading-relaxed">
                                The <span className="text-orange-500 font-bold">Orange Drone</span> represents an algorithm based strictly on mathematically-calculated proportional, integral, and derivative equations.
                            </p>
                            <div className="bg-orange-500/10 border border-orange-500/20 p-3 rounded-xl font-mono text-[9px] text-orange-400">
                                P = Target - Current<br/>
                                I = I + P<br/>
                                D = P - PrevP<br/>
                                F = Kp*P + Ki*I + Kd*D
                            </div>
                            <p className="text-xs text-muted-foreground leading-relaxed">
                                The <span className="text-white font-bold bg-zinc-800 px-1 rounded">White Drones</span> are trying to learn this exact behavior using a Neural Network through pure trial and error.
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
