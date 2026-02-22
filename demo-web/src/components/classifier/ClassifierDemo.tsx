import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as wasm from '../../wasm/pkg/gran_prix_wasm';

import { ClassifierCanvas } from './ClassifierCanvas';
import { ClassifierStatsBar } from './ClassifierStatsBar';
import { ClassifierControls } from './ClassifierControls';
import { ClassifierNetworkViz } from './ClassifierNetworkViz';
import { GameControls } from '../GameControls';
import { PerformanceCharts, PerformanceData } from '../PerformanceCharts';

interface Point {
    x: number;
    y: number;
    label: number;
}

const RESOLUTION = 40;
const DATA_SIZE = 100;

export const ClassifierDemo: React.FC<{ isWasmReady: boolean }> = ({ isWasmReady }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [trainer, setTrainer] = useState<wasm.Trainer | null>(null);
    const trainerRef = useRef<wasm.Trainer | null>(null);
    const pointsRef = useRef<Point[]>([]);
    const [isPlaying, setIsPlaying] = useState(true);
    const isPlayingRef = useRef(true);
    const [lr, setLr] = useState(0.05);
    const lrRef = useRef(0.05);
    const [hiddenSize, setHiddenSize] = useState(32);
    const [pattern, setPattern] = useState<'xor' | 'circle' | 'spiral' | 'custom'>('xor');
    const [loss, setLoss] = useState<number>(0);
    const [performanceHistory, setPerformanceHistory] = useState<PerformanceData[]>([]);
    const [generation, setGeneration] = useState(0);
    const genRef = useRef(0);
    const [initError, setInitError] = useState<string | null>(null);

    const generatePoints = useCallback((type: 'xor' | 'circle' | 'spiral' | 'custom') => {
        if (type === 'custom') return;
        const newPoints: Point[] = [];
        for (let i = 0; i < DATA_SIZE; i++) {
            const x = Math.random() * 2 - 1;
            const y = Math.random() * 2 - 1;
            let label = 0;

            if (type === 'xor') {
                label = (x > 0 && y > 0) || (x < 0 && y < 0) ? 1 : 0;
            } else if (type === 'circle') {
                label = (x * x + y * y) < 0.3 ? 1 : 0;
            } else if (type === 'spiral') {
                const r = Math.sqrt(x * x + y * y);
                const t = Math.atan2(y, x);
                label = (Math.sin(10 * r + t) > 0) ? 1 : 0;
            }
            newPoints.push({ x, y, label });
        }
        pointsRef.current = newPoints;
    }, []);

    useEffect(() => {
        if (!isWasmReady) return;

        try {
            generatePoints(pattern);
            if (typeof wasm.Trainer === 'undefined') return;

            const newTrainer = new wasm.Trainer(2, new Uint32Array([hiddenSize]));
            trainerRef.current = newTrainer;
            setTrainer(newTrainer);
            setGeneration(0);
            genRef.current = 0;
            setPerformanceHistory([]);
            setInitError(null);
        } catch (e: any) {
            console.error("Failed to initialize Trainer:", e);
            setInitError(e.toString());
        }
    }, [pattern, hiddenSize, generatePoints, isWasmReady]);

    const trainLoop = useCallback(() => {
        const currentTrainer = trainerRef.current;
        const currentPoints = pointsRef.current;
        if (!isPlayingRef.current || !currentTrainer || currentPoints.length === 0) return;

        try {
            const batchX: number[] = [];
            const batchY: number[] = [];
            const batchTarget: number[] = [];

            for (let i = 0; i < 10; i++) {
                const p = currentPoints[Math.floor(Math.random() * currentPoints.length)];
                batchX.push(p.x);
                batchY.push(p.y);
                batchTarget.push(p.label);
            }

            const batchInputs = new Float32Array(batchX.length * 2);
            for (let i = 0; i < batchX.length; i++) {
                batchInputs[i * 2] = batchX[i];
                batchInputs[i * 2 + 1] = batchY[i];
            }

            const avgLoss = currentTrainer.train_batch(
                batchInputs,
                new Float32Array(batchTarget),
                lrRef.current
            );

            setLoss(avgLoss);

            genRef.current += 1;
            if (genRef.current % 10 === 0) {
                setGeneration(genRef.current);
                setPerformanceHistory(prev => {
                    const newData = [...prev, { generation: genRef.current, avg: 1 - avgLoss, max: 1 - avgLoss }];
                    return newData.length > 50 ? newData.slice(1) : newData;
                });
            }

            // Render
            const ctx = canvasRef.current?.getContext('2d');
            if (ctx && canvasRef.current) {
                const { width, height } = canvasRef.current;

                if (genRef.current % 3 === 0) {
                    const featureMap = (x: number, y: number) => new Float32Array([x, y]);
                    const boundary = trainerRef.current!.get_decision_boundary(RESOLUTION, featureMap);
                    const cellSize = width / RESOLUTION;

                    for (let j = 0; j < RESOLUTION; j++) {
                        for (let i = 0; i < RESOLUTION; i++) {
                            const val = boundary[j * RESOLUTION + i];
                            const r = Math.floor(255 * (1 - val) * 0.2 + 20);
                            const g = Math.floor(255 * val * 0.4 + 30);
                            const b = 50;
                            ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
                            ctx.fillRect(i * cellSize, j * cellSize, cellSize + 1, cellSize + 1);
                        }
                    }
                }

                pointsRef.current.forEach(p => {
                    const px = (p.x + 1) / 2 * width;
                    const py = (p.y + 1) / 2 * height;
                    ctx.beginPath();
                    ctx.arc(px, py, 4, 0, Math.PI * 2);
                    ctx.fillStyle = p.label === 1 ? '#10b981' : '#f43f5e';
                    ctx.strokeStyle = '#fff';
                    ctx.lineWidth = 1.5;
                    ctx.fill();
                    ctx.stroke();
                });
            }
        } catch (e: any) {
            console.error("Training Step Failed:", e);
            isPlayingRef.current = false;
            setIsPlaying(false);
        }
    }, []);

    useEffect(() => {
        let frameId: number;
        const loop = () => {
            trainLoop();
            frameId = requestAnimationFrame(loop);
        };
        frameId = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(frameId);
    }, [trainLoop]);

    const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
        if (!canvasRef.current) return;
        const rect = canvasRef.current.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const y = ((e.clientY - rect.top) / rect.height) * 2 - 1;
        const label = e.shiftKey || e.button === 2 ? 0 : 1;

        setPattern('custom');
        pointsRef.current = [...pointsRef.current, { x, y, label }];
    };

    if (!isWasmReady) {
        return (
            <div className="flex flex-col items-center justify-center py-24 gap-4">
                <div className="w-12 h-12 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin" />
                <span className="text-[10px] uppercase font-black tracking-[0.3em] text-emerald-500 text-center px-4">
                    {initError ? `WASM ERROR: ${initError}` : 'Initializing Backprop Lab WASM…'}
                </span>
            </div>
        );
    }

    return (
        <div className="w-full flex flex-col items-center gap-0">
            {/* Header matches OvenDemo */}
            <div className="flex flex-col items-center mb-8">
                <h2 className="text-2xl font-black bg-gradient-to-br from-emerald-400 to-cyan-600 bg-clip-text text-transparent uppercase tracking-[0.3em]">
                    Backprop Lab
                </h2>
                <p className="text-[9px] text-muted-foreground uppercase tracking-[0.3em] mt-2 font-bold text-center">
                    Universal Function Approximation<br />
                    Gradient Descent · Neural Classifier
                </p>
            </div>

            <div className="w-full max-w-7xl flex flex-col lg:flex-row items-center lg:items-start justify-center gap-8">
                {/* Left Column — Viz + Legend */}
                <div className="flex flex-col gap-6 flex-shrink-0 w-80">
                    <div className="bg-card/50 border border-border rounded-2xl overflow-hidden backdrop-blur-md p-6">
                        <div className="border-b border-border pb-3 mb-5">
                            <h3 className="text-sm font-bold text-foreground uppercase tracking-tighter">
                                Neural Brain
                            </h3>
                            <p className="text-[9px] text-muted-foreground font-mono mt-0.5">
                                GRADIENT_DESCENT · LIVE_WEIGHTS
                            </p>
                        </div>
                        <ClassifierNetworkViz trainer={trainer} hiddenSize={hiddenSize} inputDim={2} />

                        <div className="mt-5 space-y-1.5 border-t border-border pt-4">
                            <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
                                Input Legend (2)
                            </p>
                            <div className="flex items-start gap-2">
                                <span className="text-[7px] font-mono text-emerald-500 w-5 flex-shrink-0 pt-px">I₁</span>
                                <div>
                                    <span className="text-[7px] font-bold text-foreground/70 font-mono text-cyan-400">X_COORD</span>
                                    <p className="text-[6px] text-muted-foreground leading-tight">Input value on X axis [-1..1]</p>
                                </div>
                            </div>
                            <div className="flex items-start gap-2">
                                <span className="text-[7px] font-mono text-emerald-500 w-5 flex-shrink-0 pt-px">I₂</span>
                                <div>
                                    <span className="text-[7px] font-bold text-foreground/70 font-mono text-cyan-400">Y_COORD</span>
                                    <p className="text-[6px] text-muted-foreground leading-tight">Input value on Y axis [-1..1]</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Centre — Main Dashboard */}
                <div className="flex flex-col items-center flex-shrink-0">
                    <ClassifierStatsBar stats={{ generation, loss, lr }} />
                    <ClassifierCanvas
                        ref={canvasRef}
                        onCanvasClick={handleCanvasClick}
                    />
                    <GameControls
                        isPlaying={isPlaying}
                        onTogglePlay={() => {
                            isPlayingRef.current = !isPlaying;
                            setIsPlaying(!isPlaying);
                        }}
                        onReset={() => {
                            generatePoints(pattern);
                            setGeneration(0);
                            genRef.current = 0;
                            setPerformanceHistory([]);
                        }}
                    />
                    <div className="w-full mt-8">
                        <PerformanceCharts data={performanceHistory} />
                    </div>
                </div>

                {/* Right Column — Config */}
                <div className="flex flex-col gap-6 flex-shrink-0 w-80">
                    <ClassifierControls
                        pattern={pattern}
                        onPatternChange={setPattern}
                        lr={lr}
                        onLrChange={(v) => {
                            lrRef.current = v;
                            setLr(v);
                        }}
                        hiddenSize={hiddenSize}
                        onHiddenSizeChange={setHiddenSize}
                    />
                </div>
            </div>
        </div>
    );
};
