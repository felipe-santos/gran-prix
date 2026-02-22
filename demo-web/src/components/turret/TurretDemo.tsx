import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as wasm from '../../wasm/pkg/gran_prix_wasm';

// Types & Hooks
import {
    TURRET_WIDTH,
    TURRET_HEIGHT,
    TURRET_POPULATION_SIZE,
    TurretStats
} from '../../types/turret';
import { useWasmPopulation } from '../../hooks/useWasmPopulation';
import { useTurretGameLoop } from '../../hooks/useTurretGameLoop';

// Components
import { TurretCanvas } from './TurretCanvas';
import { StatsBar } from '../StatsBar';
import { GameControls } from '../GameControls';
import { LearningLab } from '../LearningLab';

export const TurretDemo: React.FC = () => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [stats, setStats] = useState<TurretStats>({ score: 0, generation: 1, best: 0, alive: 0, bestTracking: 0, totalHits: 0 });
    const [isRestarting] = useState(false);

    // Learning Lab State
    const [mutationRate, setMutationRate] = useState(0.2);
    const [mutationScale, setMutationScale] = useState(0.5);
    const [mutationStrategy, setMutationStrategy] = useState<wasm.MutationStrategy>(wasm.MutationStrategy.Additive);
    const [customKernel, setCustomKernelState] = useState<[number, number, number]>([0, 1, 0]);

    const { population, initWasm, evolve: wasmEvolve, computeAll, setGlobalKernel } = useWasmPopulation();

    const evolve = useCallback((fitnessScores: number[], rate: number, scale: number, strategy: wasm.MutationStrategy) => {
        wasmEvolve(fitnessScores, rate, scale, strategy);
    }, [wasmEvolve]);

    const { gameState, resetGame, updatePhysics } = useTurretGameLoop({
        computeAll,
        evolve,
        setStats,
        mutationRate,
        mutationScale,
        mutationStrategy
    });

    const rafId = useRef<number | null>(null);
    const isLoopActive = useRef(false);

    // Initialize WASM
    useEffect(() => {
        if (!population) {
            initWasm().catch(console.error);
        }
    }, [initWasm, population]);

    const render = useCallback((ctx: CanvasRenderingContext2D) => {
        const state = gameState.current;

        // 1. Clear with trail effect
        const trailColor = getComputedStyle(document.documentElement).getPropertyValue('--canvas-trail').trim() || 'rgba(10, 10, 11, 0.4)';
        const isDark = trailColor.includes('10, 10, 11');
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = trailColor;
        ctx.fillRect(0, 0, TURRET_WIDTH, TURRET_HEIGHT);

        // Grid details
        const gridStyle = getComputedStyle(document.documentElement).getPropertyValue('--canvas-grid').trim() || 'rgba(255, 255, 255, 0.03)';
        ctx.strokeStyle = gridStyle;
        ctx.lineWidth = 1;
        for (let x = 0; x < TURRET_WIDTH; x += 40) {
            ctx.beginPath();
            ctx.moveTo(x, 0); ctx.lineTo(x, TURRET_HEIGHT);
            ctx.stroke();
        }
        for (let y = 0; y < TURRET_HEIGHT; y += 40) {
            ctx.beginPath();
            ctx.moveTo(0, y); ctx.lineTo(TURRET_WIDTH, y);
            ctx.stroke();
        }

        ctx.globalCompositeOperation = isDark ? 'lighter' : 'source-over';

        // 2. Draw Wind Indicator HUD
        ctx.save();
        ctx.translate(50, 50);
        ctx.beginPath();
        ctx.arc(0, 0, 20, 0, Math.PI * 2);
        ctx.strokeStyle = '#0ea5e9';
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(state.windDirection * state.windMagnitude * 10, 0); // Visual amplification
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = '#0ea5e9';
        ctx.font = '10px Inter';
        ctx.fillText(`WIND: ${(state.windMagnitude * state.windDirection).toFixed(1)}`, -10, 35);
        ctx.restore();

        // 3. Draw Drone
        ctx.beginPath();
        // A drone shape
        ctx.arc(state.drone.x, state.drone.y, 8, 0, Math.PI * 2);
        ctx.fillStyle = '#f43f5e';
        ctx.shadowColor = '#f43f5e';
        ctx.shadowBlur = 10;
        ctx.fill();
        // Drone props
        ctx.beginPath();
        ctx.moveTo(state.drone.x - 12, state.drone.y - 2);
        ctx.lineTo(state.drone.x + 12, state.drone.y - 2);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.shadowBlur = 0;
        ctx.stroke();

        // 4. Draw Turrets and Projectiles
        const TURRET_X = TURRET_WIDTH / 2;
        const TURRET_Y = TURRET_HEIGHT - 40;

        // Find best turret for highlighting
        let bestAgent = state.agents[0];
        for (const a of state.agents) {
            if (a.trackingScore > bestAgent.trackingScore) {
                bestAgent = a;
            }
        }

        state.agents.forEach(agent => {
            const isBest = agent.id === bestAgent.id;

            // Draw Laser Sight for the best performing agent to show what it is looking at
            if (isBest) {
                ctx.beginPath();
                const laserLength = 800;
                ctx.moveTo(TURRET_X, TURRET_Y);
                // Angle points from top (0), so X is sin, Y is -cos
                ctx.lineTo(
                    TURRET_X + Math.sin(agent.angle) * laserLength,
                    TURRET_Y - Math.cos(agent.angle) * laserLength
                );
                const grad = ctx.createLinearGradient(TURRET_X, TURRET_Y, TURRET_X + Math.sin(agent.angle) * laserLength, TURRET_Y - Math.cos(agent.angle) * laserLength);
                grad.addColorStop(0, 'rgba(0, 229, 255, 0.4)');
                grad.addColorStop(1, 'rgba(0, 229, 255, 0)');
                ctx.strokeStyle = grad;
                ctx.lineWidth = 2;
                ctx.stroke();
            }

            // Draw Turret Barrel
            ctx.save();
            ctx.translate(TURRET_X, TURRET_Y);
            ctx.rotate(agent.angle);
            ctx.beginPath();
            // Barrel
            ctx.moveTo(-2, 0);
            ctx.lineTo(-2, -30);
            ctx.lineTo(2, -30);
            ctx.lineTo(2, 0);
            ctx.fillStyle = isBest ? '#00e5ff' : 'rgba(0, 229, 255, 0.05)';
            if (isBest) {
                ctx.shadowColor = '#00e5ff';
                ctx.shadowBlur = 15;
            }
            ctx.fill();
            ctx.restore();

            // Draw Projectiles
            ctx.shadowBlur = 0;
            agent.projectiles.forEach(p => {
                ctx.beginPath();
                ctx.moveTo(p.x, p.y);
                // Tracer back
                ctx.lineTo(p.x - p.vx * 1.5, p.y - p.vy * 1.5);
                ctx.strokeStyle = isBest ? '#10b981' : 'rgba(16, 185, 129, 0.1)';
                ctx.lineWidth = 3;
                ctx.stroke();
            });
        });

        // Draw Turret Base (Global for all)
        ctx.beginPath();
        ctx.arc(TURRET_X, TURRET_Y, 20, Math.PI, Math.PI * 2);
        ctx.fillStyle = '#0f172a';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(TURRET_X, TURRET_Y, 20, Math.PI, Math.PI * 2);
        ctx.strokeStyle = '#00e5ff';
        ctx.lineWidth = 2;
        ctx.stroke();

    }, [gameState]);

    const gameLoop = useCallback(() => {
        if (!isPlaying) {
            isLoopActive.current = false;
            return;
        }

        if (!canvasRef.current) {
            rafId.current = requestAnimationFrame(gameLoop);
            return;
        }

        const ctx = canvasRef.current.getContext('2d');
        if (!ctx) return;

        updatePhysics();
        render(ctx);

        rafId.current = requestAnimationFrame(gameLoop);
    }, [isPlaying, updatePhysics, render]);

    useEffect(() => {
        if (isPlaying && !isLoopActive.current) {
            isLoopActive.current = true;
            rafId.current = requestAnimationFrame(gameLoop);
        }
        return () => {
            if (rafId.current) cancelAnimationFrame(rafId.current);
            isLoopActive.current = false;
        };
    }, [isPlaying, gameLoop]);

    return (
        <div className="w-full max-w-7xl flex flex-col lg:flex-row items-center lg:items-start justify-center gap-8 py-8 transition-all duration-500">
            <div className="flex flex-col gap-6 flex-shrink-0">
                <div className="pt-0">
                    <LearningLab
                        mutationRate={mutationRate}
                        setMutationRate={setMutationRate}
                        mutationScale={mutationScale}
                        setMutationScale={setMutationScale}
                        mutationStrategy={mutationStrategy}
                        setMutationStrategy={setMutationStrategy}
                        customKernel={customKernel}
                        setCustomKernel={(k: [number, number, number]) => {
                            setCustomKernelState(k);
                            setGlobalKernel(k[0], k[1], k[2]);
                        }}
                    />
                </div>
            </div>

            <div className="flex flex-col items-center flex-shrink-0">
                <StatsBar stats={stats} />

                {/* Custom HUD display for Turret metrics */}
                <div className="w-full p-4 mt-2 mb-4 bg-cyan-950/20 border border-cyan-500/20 rounded-xl flex items-center justify-between">
                    <span className="text-[10px] font-mono text-cyan-400 uppercase tracking-widest">Global Tracking: {stats.bestTracking}</span>
                    <span className="text-[10px] font-mono text-emerald-400 uppercase tracking-widest">Total Air Kills: {stats.totalHits}</span>
                </div>

                <TurretCanvas
                    ref={canvasRef}
                    width={TURRET_WIDTH}
                    height={TURRET_HEIGHT}
                />

                <GameControls
                    isPlaying={isPlaying}
                    onTogglePlay={() => setIsPlaying(!isPlaying)}
                    onReset={() => {
                        resetGame();
                        setStats({ score: 0, generation: 1, best: 0, alive: TURRET_POPULATION_SIZE, bestTracking: 0, totalHits: 0 });
                    }}
                    isRestarting={isRestarting}
                />
            </div>

            <div className="w-80 flex-shrink-0 hidden lg:block opacity-0" />
        </div>
    );
};
