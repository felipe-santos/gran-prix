import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as wasm from '../../wasm/pkg/gran_prix_wasm';

import {
    DRONE_WIDTH,
    DRONE_HEIGHT,
    DRONE_SIZE,
    DRONE_POPULATION_SIZE,
    TARGET_RADIUS,
    DroneStats,
} from '../../types';
import { PerformanceData, PerformanceCharts } from '../PerformanceCharts';
import { useDroneWasm } from '../../hooks/useDroneWasm';
import { useDroneGameLoop } from '../../hooks/useDroneGameLoop';

import { DroneCanvas } from './DroneCanvas';
import { DroneStatsBar } from './DroneStatsBar';
import { GameControls } from '../GameControls';
import { DroneNetworkViz } from './DroneNetworkViz';

const DEFAULT_MUTATION_RATE = 0.15;
const DEFAULT_MUTATION_SCALE = 0.4;

function drawBackground(ctx: CanvasRenderingContext2D, isDark: boolean): void {
    const trailColor = isDark
        ? 'rgba(8, 8, 12, 1)'
        : 'rgba(248, 248, 249, 1)';
    ctx.fillStyle = trailColor;
    ctx.fillRect(0, 0, DRONE_WIDTH, DRONE_HEIGHT);

    const gridColor = isDark
        ? 'rgba(255,255,255,0.025)'
        : 'rgba(0,0,0,0.025)';
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;

    for (let x = 0; x < DRONE_WIDTH; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, DRONE_HEIGHT);
        ctx.stroke();
    }
    for (let y = 0; y < DRONE_HEIGHT; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(DRONE_WIDTH, y);
        ctx.stroke();
    }
}

function drawTarget(ctx: CanvasRenderingContext2D, tx: number, ty: number) {
    // Outer dashed ring
    ctx.beginPath();
    ctx.arc(tx, ty, TARGET_RADIUS * 2, 0, Math.PI * 2);
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.4)'; // Emerald
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);

    // Inner target point
    ctx.beginPath();
    ctx.arc(tx, ty, TARGET_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(16, 185, 129, 0.1)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Crosshair
    ctx.beginPath();
    ctx.moveTo(tx - 10, ty);
    ctx.lineTo(tx + 10, ty);
    ctx.moveTo(tx, ty - 10);
    ctx.lineTo(tx, ty + 10);
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.8)';
    ctx.stroke();
}

function drawDrones(
    ctx: CanvasRenderingContext2D,
    drones: { x: number; y: number; dead: boolean; color: string }[],
    isDark: boolean,
) {
    drones.forEach(drone => {
        if (drone.dead) return; // Keep it clean, don't draw dead drones for this demo

        ctx.globalAlpha = 0.6;
        ctx.fillStyle = isDark ? '#fff' : '#000'; // Neural drones are white/black
        
        ctx.beginPath();
        ctx.arc(drone.x, drone.y, DRONE_SIZE / 2, 0, Math.PI * 2);
        ctx.fill();
    });
    ctx.globalAlpha = 1.0;
}

function drawPidDrone(
    ctx: CanvasRenderingContext2D,
    pidDrone: { x: number; y: number; color: string }
) {
    ctx.fillStyle = pidDrone.color; // Orange for PID Reference
    ctx.beginPath();
    ctx.arc(pidDrone.x, pidDrone.y, DRONE_SIZE / 1.5, 0, Math.PI * 2);
    ctx.fill();
    
    // Outline for PID Drone
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Small label 'PID' above it
    ctx.font = 'bold 10px Inter';
    ctx.fillStyle = pidDrone.color;
    ctx.textAlign = 'center';
    ctx.fillText('PID', pidDrone.x, pidDrone.y - 15);
}

function drawWindIndicator(ctx: CanvasRenderingContext2D, windX: number, windY: number) {
    ctx.font = 'bold 10px Inter';
    ctx.fillStyle = 'rgba(239, 68, 68, 0.8)'; // Red for wind 
    ctx.textAlign = 'right';
    ctx.fillText(`WIND: ${(windX * 100).toFixed(1)} / ${(windY * 100).toFixed(1)}`, DRONE_WIDTH - 20, 20);
    
    // Draw wind vector
    ctx.beginPath();
    ctx.moveTo(DRONE_WIDTH - 50, 40);
    ctx.lineTo(DRONE_WIDTH - 50 + windX * 150, 40 + windY * 150);
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.8)';
    ctx.lineWidth = 2;
    ctx.stroke();
}

export const DroneDemo: React.FC = () => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rafRef = useRef<number | null>(null);
    const isLoopActive = useRef(false);

    const [isPlaying, setIsPlaying] = useState(false);
    const [stats, setStats] = useState<DroneStats>({
        generation: 1,
        best: 0,
        alive: 0,
        avgFitness: 0,
    });
    const [performanceHistory, setPerformanceHistory] = useState<PerformanceData[]>([]);
    const fitnessRef = useRef<Float32Array>(new Float32Array(DRONE_POPULATION_SIZE));

    const { population, initDroneWasm, computeDrone, evolveDrone } = useDroneWasm();

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

    const evolveWithTracking = useCallback(
        (
            fitnessScores: number[],
            rate: number,
            scale: number,
            strategy: wasm.MutationStrategy,
        ) => {
            fitnessRef.current = Float32Array.from(fitnessScores);
            evolveDrone(fitnessScores, rate, scale, strategy);
        },
        [evolveDrone],
    );

    const { gameState, resetDrone, updateDronePhysics } = useDroneGameLoop({
        computeDrone,
        evolve: evolveWithTracking,
        setStats,
        mutationRate: DEFAULT_MUTATION_RATE,
        mutationScale: DEFAULT_MUTATION_SCALE,
        mutationStrategy: wasm.MutationStrategy.Additive,
        onGenerationEnd: handleGenerationEnd,
    });

    useEffect(() => {
        if (!population) {
            initDroneWasm().then(() => {
                resetDrone();
                setStats(s => ({ ...s, alive: DRONE_POPULATION_SIZE }));
            });
        }
    }, [initDroneWasm, population, resetDrone]);

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
        drawTarget(ctx, state.targetX, state.targetY);
        drawDrones(ctx, state.drones, isDark);
        drawPidDrone(ctx, state.pidDrone);
        drawWindIndicator(ctx, state.windX, state.windY);
    }, [gameState]);

    const gameLoop = useCallback(() => {
        if (!isPlaying) {
            isLoopActive.current = false;
            return;
        }
        // Run physics multiple times per render frame to speed up learning? 
        // For physics logic visual demo, 1 tick per frame is better.
        updateDronePhysics();
        render();
        rafRef.current = requestAnimationFrame(gameLoop);
    }, [isPlaying, updateDronePhysics, render]);

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
        resetDrone();
        setStats({ generation: 1, best: 0, alive: DRONE_POPULATION_SIZE, avgFitness: 0 });
        setPerformanceHistory([]);
        fitnessRef.current = new Float32Array(DRONE_POPULATION_SIZE);
    }, [resetDrone]);

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
                            population={population}
                            fitnessScores={fitnessRef.current}
                            inputSize={4}
                            hiddenSize={8}
                            outputSize={2}
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
                    <DroneStatsBar stats={stats} />
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
