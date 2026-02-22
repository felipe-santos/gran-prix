import React, {
    useEffect,
    useRef,
    useState,
    useCallback,
} from 'react';

import { 
    FLAPPY_WIDTH, 
    FLAPPY_HEIGHT, 
    FlappyStats 
} from '../../types';
import { PerformanceCharts } from '../PerformanceCharts';
import { useSimulation } from '../../hooks/useSimulation';
import { flappySimulationConfig, FlappySimulationState } from '../../demos/flappy/flappySimulation';

import { FlappyCanvas } from './FlappyCanvas';
import { FlappyStatsBar } from './FlappyStatsBar';
import { FlappyControls } from './FlappyControls';
import { FlappyNetworkViz } from './FlappyNetworkViz';
import { drawBackground, drawPipes, drawBirds, drawHUD } from './renderers';

export const FlappyDemo: React.FC = () => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rafRef = useRef<number | null>(null);
    const isLoopActive = useRef(false);

    const [isPlaying, setIsPlaying] = useState(false);
    
    // Unified Simulation Engine
    const { internalState, stats, performanceHistory, isReady, update, reset, engine } = useSimulation<any, FlappySimulationState, FlappyStats>(flappySimulationConfig);

    // ── Handlers ──────────────────────────────────────────────────────────────
    const handleReset = useCallback(() => {
        setIsPlaying(false);
        reset();
    }, [reset]);

    // ── Canvas render (imperative — no React state involved) ──────────────────
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
        drawPipes(ctx, state.pipes);
        drawBirds(ctx, state.agents, isDark);
        drawHUD(ctx, state.generation, state.score, state.agents.filter(a => !a.dead).length);
    }, [internalState]);

    // ── Game loop ─────────────────────────────────────────────────────────────
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

    // ── Loading guard ─────────────────────────────────────────────────────────
    if (!isReady || !internalState.current) {
        return (
            <div className="w-full flex flex-col items-center justify-center py-24 gap-4">
                <div className="w-12 h-12 border-4 border-sky-500/20 border-t-sky-500 rounded-full animate-spin" />
                <span className="text-[10px] uppercase font-black tracking-[0.3em] text-sky-500">
                    Initializing WASM Engine…
                </span>
            </div>
        );
    }

    return (
        <div className="w-full flex flex-col items-center gap-0">
            {/* Header */}
            <div className="flex flex-col items-center mb-8">
                <h2 className="text-2xl font-black bg-gradient-to-br from-sky-400 to-indigo-600 bg-clip-text text-transparent uppercase tracking-[0.3em]">
                    Neuro Flappy
                </h2>
                <p className="text-[9px] text-muted-foreground uppercase tracking-[0.3em] mt-2 font-bold">
                    Genetic Algorithm · Reinforcement Learning
                </p>
            </div>

            <div className="w-full max-w-7xl flex flex-col lg:flex-row items-center lg:items-start justify-center gap-8">
                {/* Left side: Network Viz */}
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
                        <FlappyNetworkViz
                            population={(engine as any)?.populations.get('main')}
                            fitnessScores={engine?.fitnessScores.get('main') || new Float32Array()}
                        />
                        <div className="mt-5 space-y-1.5 border-t border-border pt-4">
                            <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
                                Inputs (3)
                            </p>
                            {[
                                ['I₁', 'birdY', 'Vertical position'],
                                ['I₂', 'pipeX', 'Distance to next pipe'],
                                ['I₃', 'pipeY', 'Height of pipe opening'],
                            ].map(([idx, name, desc]) => (
                                <div key={idx} className="flex items-start gap-2">
                                    <span className="text-[8px] font-mono text-sky-500 w-5 flex-shrink-0 pt-px">{idx}</span>
                                    <div>
                                        <span className="text-[8px] font-bold text-foreground/70 font-mono">{name}</span>
                                        <p className="text-[7px] text-muted-foreground leading-tight">{desc}</p>
                                    </div>
                                </div>
                            ))}
                            <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground mb-2 mt-4 pt-2 border-t border-border">
                                Output (1) &rarr; Flap [0, 1]
                            </p>
                        </div>
                    </div>
                </div>

                {/* Center side: Canvas + Control */}
                <div className="flex flex-col items-center flex-shrink-0">
                    <FlappyStatsBar stats={stats} />
                    <FlappyCanvas ref={canvasRef} width={FLAPPY_WIDTH} height={FLAPPY_HEIGHT} />
                    <FlappyControls
                        isPlaying={isPlaying}
                        onTogglePlay={() => setIsPlaying(p => !p)}
                        onReset={handleReset}
                    />
                    <div className="w-full mt-8">
                         <PerformanceCharts data={performanceHistory} />
                    </div>
                </div>

                {/* Right side: Strategy Info */}
                <div className="hidden lg:flex flex-col gap-6 flex-shrink-0 w-80">
                    <div className="bg-card/50 border border-border rounded-2xl p-6 backdrop-blur-md">
                        <h3 className="text-xs font-bold text-sky-500 uppercase tracking-widest mb-4">
                            Training Strategy
                        </h3>
                        <div className="space-y-4">
                            <p className="text-xs text-muted-foreground leading-relaxed">
                                Each bird is controlled by a unique neural network. 
                                The <span className="text-sky-400 font-bold">Healthiest Birds</span> 
                                (those who fly furthest) pass their "DNA" to the next generation.
                            </p>
                            <div className="bg-sky-500/5 rounded-xl p-3 border border-sky-500/10">
                                <h4 className="text-[10px] font-bold text-sky-400 uppercase mb-2">Mutation Policy</h4>
                                <ul className="text-[10px] space-y-1.5 text-muted-foreground">
                                    <li className="flex items-center gap-2">
                                        <div className="w-1 h-1 rounded-full bg-sky-400" />
                                        <span>Rate: {(flappySimulationConfig.mutationRate! * 100).toFixed(0)}%</span>
                                    </li>
                                    <li className="flex items-center gap-2">
                                        <div className="w-1 h-1 rounded-full bg-sky-400" />
                                        <span>Scale: {flappySimulationConfig.mutationScale}</span>
                                    </li>
                                </ul>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
