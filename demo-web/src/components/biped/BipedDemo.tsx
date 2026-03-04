import React, { useEffect, useRef } from 'react';
import { NetworkViz } from '../shared/NetworkViz';
import { GameControls } from '../GameControls';
import { BipedStatsBar } from './BipedStatsBar';
import { PerformanceCharts } from '../PerformanceCharts';
import { useBipedEvolution, BIPED_SENSORS, BIPED_MOTORS, BIPED_HIDDEN } from './useBipedEvolution';
import { PHYSICS_SCALE } from './BipedPhysics';

export const BipedDemo: React.FC = () => {
    const {
        agents,
        generation,
        frame,
        maxFitness,
        isRunning,
        setIsRunning,
        population,
        fitnessScores
    } = useBipedEvolution();

    const canvasRef = useRef<HTMLCanvasElement>(null);

    // Render Loop
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // We only render periodically or when explicitly requested to save CPU for WASM
        let renderId: number;

        const render = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            // Camera Tracking: Follow the furthest agent
            const bestAgent = agents.reduce((best, a) => a.fitness > best.fitness ? a : best, agents[0]);
            let camX = 0;
            if (bestAgent) {
                camX = bestAgent.physics.getState().headX * PHYSICS_SCALE - canvas.width / 4;
            }

            ctx.save();
            // Move camera and flip Y-axis for correct physics rendering (0,0 bottom left)
            ctx.translate(-camX, canvas.height);
            ctx.scale(1, -1);

            // Draw Ground
            ctx.fillStyle = '#22c55e'; // Green ground
            ctx.fillRect(camX, 0, canvas.width, 10);

            // Draw Grid relative to camera
            ctx.strokeStyle = '#334155'; // slate-700
            ctx.lineWidth = 1;
            const startGridX = Math.floor(camX / 50) * 50;
            for (let x = startGridX; x < startGridX + canvas.width + 100; x += 50) {
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, canvas.height);
                ctx.stroke();
            }

            // Draw Agents
            // Sort so best is drawn last (on top)
            const sortedAgents = [...agents].sort((a, b) => a.fitness - b.fitness);

            sortedAgents.forEach(agent => {
                if (!agent.isAlive) return; // Only draw alive (or draw ghosts?)

                ctx.strokeStyle = agent.color;

                // Emphasize the leader
                if (agent === bestAgent) {
                    ctx.lineWidth = 4;
                    ctx.shadowBlur = 10;
                    ctx.shadowColor = agent.color;
                } else {
                    ctx.lineWidth = 2;
                    ctx.globalAlpha = 0.3;
                    ctx.shadowBlur = 0;
                }

                const bodies = agent.physics.getBodies();
                bodies.forEach(body => {
                    const pos = body.getPosition();
                    const angle = body.getAngle();
                    const fixture = body.getFixtureList();

                    if (fixture) {
                        const shape = fixture.getShape() as any;
                        if (shape.m_vertices) {
                            ctx.save();
                            ctx.translate(pos.x * PHYSICS_SCALE, pos.y * PHYSICS_SCALE);
                            ctx.rotate(angle);

                            ctx.beginPath();
                            const v0 = shape.m_vertices[0];
                            ctx.moveTo(v0.x * PHYSICS_SCALE, v0.y * PHYSICS_SCALE);
                            for (let i = 1; i < shape.m_count; i++) {
                                const v = shape.m_vertices[i];
                                ctx.lineTo(v.x * PHYSICS_SCALE, v.y * PHYSICS_SCALE);
                            }
                            ctx.closePath();

                            ctx.fillStyle = agent === bestAgent ? agent.color : '#475569';
                            ctx.fill();
                            ctx.stroke();

                            ctx.restore();
                        }
                    }
                });
                ctx.globalAlpha = 1.0;
            });

            ctx.restore();
            renderId = requestAnimationFrame(render);
        };

        renderId = requestAnimationFrame(render);
        return () => cancelAnimationFrame(renderId);
    }, [agents]);

    return (
        <div className="w-full flex flex-col items-center">
            {/* Header */}
            <div className="flex flex-col items-center mb-10">
                <h2 className="text-3xl font-black bg-gradient-to-br from-slate-400 to-slate-200 bg-clip-text text-transparent uppercase tracking-[0.4em] drop-shadow-sm text-center">
                    Temporal Biped
                </h2>
                <div className="flex items-center gap-3 mt-3">
                    <span className="h-px w-8 bg-slate-500/30" />
                    <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-[0.3em] text-center">
                        GRU Memory Locomotion
                    </p>
                    <span className="h-px w-8 bg-slate-500/30" />
                </div>
            </div>

            {/* 3-Column Layout */}
            <div className="w-full max-w-7xl flex flex-col xl:flex-row items-center xl:items-start justify-center gap-10">

                {/* Left Column: Network Viz */}
                <div className="flex flex-col gap-8 flex-shrink-0 w-[340px]">
                    <div className="bg-card/40 border border-border/50 rounded-[2rem] overflow-hidden backdrop-blur-xl shadow-2xl shadow-slate-500/5">
                        <div className="p-6 border-b border-border/50 bg-card/60">
                            <h3 className="text-xs font-black text-foreground uppercase tracking-[0.2em] flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-slate-500 animate-pulse" />
                                Temporal CPU (GRU)
                            </h3>
                        </div>
                        <div className="p-8">
                            <NetworkViz
                                population={population}
                                fitnessScores={fitnessScores}
                                inputs={BIPED_SENSORS}
                                hidden={BIPED_HIDDEN}
                                outputs={BIPED_MOTORS}
                            />

                            <div className="mt-8 space-y-4 pt-6 border-t border-border/50">
                                <div>
                                    <label className="text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground block mb-3">
                                        Sensor Inputs (10)
                                    </label>
                                    <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                                        {[
                                            'Torso Angle', 'L Hip Angle',
                                            'L Knee Angle', 'R Hip Angle',
                                            'R Knee Angle', 'Head Y',
                                            'Head X', 'L Foot Contact',
                                            'R Foot Contact', 'Velocity X'
                                        ].map((label, i) => (
                                            <div key={label} className="flex items-center gap-2 opacity-70">
                                                <span className="text-[8px] font-mono text-slate-500">I{i}</span>
                                                <span className="text-[9px] font-medium">{label}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                                <div className="pt-2">
                                    <label className="text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground block mb-3">
                                        Motor Outputs (4)
                                    </label>
                                    <div className="flex gap-4">
                                        {['L Hip', 'L Knee', 'R Hip', 'R Knee'].map((label, i) => (
                                            <div key={label} className="flex flex-col items-center">
                                                <span className="text-[8px] font-mono text-slate-500">O{i}</span>
                                                <span className="text-[8px] font-bold uppercase mt-1">{label}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Center Column: Simulation */}
                <div className="flex flex-col items-center flex-grow max-w-[800px]">
                    <BipedStatsBar
                        generation={generation}
                        frame={frame}
                        population={agents.filter(a => a.isAlive).length}
                        maxFitness={maxFitness}
                    />

                    <div className="relative w-full aspect-[2/1] bg-card/20 rounded-[2rem] border border-border/50 overflow-hidden shadow-2xl backdrop-blur-sm">
                        <canvas
                            ref={canvasRef}
                            width={800}
                            height={400}
                            className="w-full h-full object-cover"
                        />
                        {/* Fallback Overlay when compiling/loading */}
                        {agents.length === 0 && (
                            <div className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-sm">
                                <div className="text-center">
                                    <div className="w-12 h-12 border-4 border-slate-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
                                    <p className="text-foreground tracking-[0.2em] text-xs font-black uppercase">Assembling Temporal Bipeds...</p>
                                    <p className="text-[10px] text-muted-foreground mt-2 uppercase tracking-widest">Loading WASM Engine</p>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="w-full mt-6 bg-card/30 border border-border/50 rounded-2xl p-4 backdrop-blur-sm">
                        <GameControls
                            isPlaying={isRunning}
                            onTogglePlay={() => setIsRunning(!isRunning)}
                            onReset={() => {
                                setIsRunning(false);
                            }}
                        />
                    </div>

                    <div className="w-full mt-8 grid grid-cols-1 gap-6">
                        <div className="bg-card/40 border border-border/50 rounded-3xl p-6 backdrop-blur-md">
                            <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground mb-4 px-2">
                                Evolution Progress
                            </h3>
                            <PerformanceCharts data={[{ generation: 1, max: 0, avg: 0 }]} />
                        </div>
                    </div>
                </div>

                {/* Right Column: Information/Config */}
                <div className="hidden xl:flex flex-col gap-6 flex-shrink-0 w-80">
                    <div className="bg-card/40 border border-border/50 rounded-[2rem] p-8 backdrop-blur-md">
                        <h3 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em] mb-6 border-b border-border/50 pb-4">
                            The GRU Challenge
                        </h3>
                        <div className="space-y-6">
                            <div className="space-y-2">
                                <p className="text-[11px] text-muted-foreground leading-relaxed">
                                    Unlike simple reflexes, bipedal walking requires <span className="text-slate-200 font-bold">Temporal Memory</span>.
                                </p>
                            </div>

                            <div className="bg-zinc-950/40 rounded-2xl p-4 border border-border/30">
                                <h4 className="text-[9px] font-black uppercase tracking-[0.1em] text-slate-500 mb-3">
                                    Why GRU Layers?
                                </h4>
                                <ul className="space-y-2">
                                    <li className="flex items-start gap-2 text-[10px] text-muted-foreground leading-relaxed">
                                        <div className="w-1 h-1 rounded-full bg-slate-500 mt-1.5 flex-shrink-0" />
                                        <span>Agents must remember which leg is pushing to coordinate alternating swings.</span>
                                    </li>
                                    <li className="flex items-start gap-2 text-[10px] text-muted-foreground leading-relaxed">
                                        <div className="w-1 h-1 rounded-full bg-slate-500 mt-1.5 flex-shrink-0" />
                                        <span>Momentum needs to be tracked across hundreds of frames internally.</span>
                                    </li>
                                </ul>
                            </div>

                            <p className="text-[11px] text-muted-foreground leading-relaxed italic opacity-80">
                                This simulation resets the internal GRU memory graph at the start of every episode to prevent hallucinated momentum.
                            </p>
                        </div>
                    </div>
                </div>

            </div>
        </div>
    );
};
