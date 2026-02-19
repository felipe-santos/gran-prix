import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as wasm from '../wasm/pkg/gran_prix_wasm';

interface Point {
    x: number;
    y: number;
    label: number;
}

const RESOLUTION = 40;
const DATA_SIZE = 100;

const NetworkVisualization: React.FC<{ trainer: wasm.Trainer | null, hiddenSize: number }> = ({ trainer, hiddenSize }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        if (!trainer || !canvasRef.current) return;
        const ctx = canvasRef.current.getContext('2d');
        if (!ctx) return;

        const draw = () => {
            const weights = trainer.get_weights();
            if (!weights) return;

            const { width, height } = canvasRef.current!;
            ctx.clearRect(0, 0, width, height);

            const layers = [2, hiddenSize, 1];
            const layerX = [width * 0.2, width * 0.5, width * 0.8];
            const nodeRadius = 12;

            // Draw Connections First
            let wIdx = 0;
            for (let l = 0; l < layers.length - 1; l++) {
                const currentLayerNodes = layers[l];
                const nextLayerNodes = layers[l + 1];

                for (let i = 0; i < currentLayerNodes; i++) {
                    const y1 = (height / (currentLayerNodes + 1)) * (i + 1);
                    for (let j = 0; j < nextLayerNodes; j++) {
                        const y2 = (height / (nextLayerNodes + 1)) * (j + 1);
                        const weight = weights[wIdx++];
                        
                        // Color based on sign, thickness based on magnitude
                        ctx.beginPath();
                        ctx.moveTo(layerX[l], y1);
                        ctx.lineTo(layerX[l + 1], y2);
                        ctx.lineWidth = Math.min(Math.abs(weight) * 3, 4);
                        ctx.strokeStyle = weight > 0 ? `rgba(16, 185, 129, ${0.1 + Math.abs(weight)})` : `rgba(244, 63, 94, ${0.1 + Math.abs(weight)})`;
                        ctx.stroke();
                    }
                }
                // Skip biases for simpler visualization of weights convergence
                wIdx += nextLayerNodes; 
            }

            // Draw Nodes
            layers.forEach((nodeCount, l) => {
                for (let i = 0; i < nodeCount; i++) {
                    const y = (height / (nodeCount + 1)) * (i + 1);
                    ctx.beginPath();
                    ctx.arc(layerX[l], y, nodeRadius, 0, Math.PI * 2);
                    ctx.fillStyle = '#1e1e24';
                    ctx.strokeStyle = '#3f3f46';
                    ctx.lineWidth = 2;
                    ctx.fill();
                    ctx.stroke();
                }
            });

            requestAnimationFrame(draw);
        };

        const raf = requestAnimationFrame(draw);
        return () => cancelAnimationFrame(raf);
    }, [trainer, hiddenSize]);

    return (
        <div className="flex flex-col items-center gap-2">
            <span className="text-[9px] uppercase font-bold tracking-[0.3em] text-muted-foreground mb-1">Architecture Weights</span>
            <canvas 
                ref={canvasRef} 
                width={300} 
                height={200} 
                className="bg-black/20 rounded-lg border border-white/5"
            />
        </div>
    );
};

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
    const [lossHistory, setLossHistory] = useState<number[]>([]);
    const [generation, setGeneration] = useState(0);
    const genRef = useRef(0);
    const [initError, setInitError] = useState<string | null>(null);

    const generatePoints = useCallback((type: 'xor' | 'circle' | 'spiral' | 'custom') => {
        if (type === 'custom') return; // Keep existing custom points
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
        setPointsSynced(newPoints);
    }, []);

    useEffect(() => {
        if (!isWasmReady) return;
        
        try {
            generatePoints(pattern);
            // Ensure WASM classes are available
            if (typeof wasm.Trainer === 'undefined') {
                console.warn("WASM: Trainer class not yet available in module.");
                return;
            }
            console.log("WASM: Creating new Trainer for pattern:", pattern);
            const newTrainer = new wasm.Trainer(hiddenSize);
            setTrainerSynced(newTrainer);
            setGeneration(0);
            genRef.current = 0;
            setInitError(null);
        } catch (e: any) {
            console.error("Failed to initialize Trainer:", e);
            setInitError(e.toString());
        }
    }, [pattern, hiddenSize, generatePoints, isWasmReady]);

    // Keep refs in sync with state so trainLoop never needs to be recreated
    const setTrainerSynced = (t: wasm.Trainer | null) => { trainerRef.current = t; setTrainer(t); };
    const setPointsSynced = (p: Point[]) => { pointsRef.current = p; };
    const setIsPlayingSynced = (v: boolean) => { isPlayingRef.current = v; setIsPlaying(v); };
    const setLrSynced = (v: number) => { lrRef.current = v; setLr(v); };

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

            const avgLoss = currentTrainer.train_batch(
                new Float32Array(batchX), 
                new Float32Array(batchY), 
                new Float32Array(batchTarget), 
                lrRef.current
            );
            
            setLoss(avgLoss);
            setLossHistory(prev => [...prev.slice(-40), avgLoss]);
            
            genRef.current += 1;
            setGeneration(genRef.current);

            if (genRef.current % 100 === 0) {
                console.log(`Training Lab: Epoch ${genRef.current}, Loss: ${avgLoss.toFixed(6)}`);
            }
        } catch (e: any) {
            console.error("Training Step Failed:", e);
            isPlayingRef.current = false;
            setIsPlaying(false);
            return;
        }

        // Render
        const ctx = canvasRef.current?.getContext('2d');
        if (ctx && canvasRef.current) {
            const { width, height } = canvasRef.current;
            
            // Draw Decision Boundary every 5 frames for performance
            if (genRef.current % 5 === 0) {
                const boundary = trainerRef.current!.get_decision_boundary(RESOLUTION);
                const cellSize = width / RESOLUTION;

                for (let j = 0; j < RESOLUTION; j++) {
                    for (let i = 0; i < RESOLUTION; i++) {
                        const val = boundary[j * RESOLUTION + i];
                        const r = Math.floor(255 * (1 - val) * 0.3 + 20);
                        const g = Math.floor(255 * val * 0.6 + 20);
                        const b = 40;
                        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
                        ctx.fillRect(i * cellSize, j * cellSize, cellSize + 1, cellSize + 1);
                    }
                }
            }

            // Draw Points always
            pointsRef.current.forEach(p => {
                const px = (p.x + 1) / 2 * width;
                const py = (p.y + 1) / 2 * height;
                ctx.beginPath();
                ctx.arc(px, py, 4, 0, Math.PI * 2);
                ctx.fillStyle = p.label === 1 ? '#10b981' : '#f43f5e';
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.fill();
                ctx.stroke();
            });
        }
    // Empty deps: trainLoop never recreates, reads everything via refs
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
        
        // Left click = Label 1, Right click or Shift+Click = Label 0
        const label = e.shiftKey || e.button === 2 ? 0 : 1;
        
        setPattern('custom');
        setPointsSynced([...pointsRef.current, { x, y, label }]);
    };

    return (
        <div className="flex flex-col lg:flex-row items-center justify-center gap-12 p-8 bg-muted/40 rounded-3xl border border-white/5 backdrop-blur-3xl shadow-2xl min-h-[600px]">
            {!isWasmReady ? (
                <div className="flex flex-col items-center gap-4 py-12">
                    <div className="w-12 h-12 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin" />
                    <span className="text-[10px] uppercase font-black tracking-[0.3em] text-emerald-500">
                        {initError ? `WASM ERROR: ${initError}` : 'Initializing WASM Engine...'}
                    </span>
                </div>
            ) : (
                <>
                <div className="flex flex-col items-center gap-8">
                <div className="flex flex-col items-center gap-2">
                    <h2 className="text-2xl font-black bg-gradient-to-br from-emerald-400 to-cyan-400 bg-clip-text text-transparent uppercase tracking-[0.3em]">
                        Backprop Lab
                    </h2>
                    <div className="flex gap-6 text-[11px] uppercase font-black tracking-[0.2em] text-muted-foreground/60">
                        <span>Loss: <span className="text-emerald-500 font-mono">{loss.toFixed(6)}</span></span>
                        <span>Epochs: <span className="text-cyan-500 font-mono">{generation}</span></span>
                    </div>
                </div>

                <div className="relative group">
                    <canvas 
                        ref={canvasRef} 
                        width={400} 
                        height={400} 
                        onClick={handleCanvasClick}
                        onContextMenu={(e) => { e.preventDefault(); handleCanvasClick(e as any); }}
                        className="rounded-2xl shadow-2xl shadow-black/80 border border-white/10 overflow-hidden ring-1 ring-white/5 cursor-crosshair"
                    />
                    <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none flex items-end justify-center pb-4">
                        <span className="text-[10px] bg-black/80 text-white/60 px-3 py-1 rounded-full backdrop-blur-md border border-white/10 uppercase tracking-widest font-bold">
                            Click to add points (Left: Green, Shift: Rose)
                        </span>
                    </div>
                </div>
            </div>

            <div className="flex flex-col gap-8 w-full max-w-[320px]">
                <NetworkVisualization trainer={trainer} hiddenSize={hiddenSize} />

                <div className="flex flex-col gap-2">
                    <label className="text-[10px] uppercase font-bold tracking-widest text-muted-foreground">Pattern</label>
                    <div className="grid grid-cols-2 gap-2">
                        {(['xor', 'circle', 'spiral', 'custom'] as const).map(p => (
                            <button
                                key={p}
                                onClick={() => {
                                    if (p !== 'custom') generatePoints(p);
                                    setPattern(p);
                                }}
                                className={`px-2 py-1.5 rounded-lg text-[10px] border transition-all ${
                                    pattern === p 
                                    ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400' 
                                    : 'bg-white/5 border-white/10 hover:bg-white/10'
                                } uppercase tracking-widest font-black`}
                            >
                                {p}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="flex flex-col gap-2">
                    <label className="text-[10px] uppercase font-bold tracking-widest text-muted-foreground">Loss Convergence</label>
                    <div className="h-10 bg-muted/40 rounded-lg border border-white/5 flex items-end gap-[1px] p-2 overflow-hidden">
                        {lossHistory.map((l, i) => (
                            <div 
                                key={i} 
                                className="bg-emerald-500/40 w-full" 
                                style={{ height: `${Math.min(100, Math.max(5, (1 - l) * 100))}%` }} 
                            />
                        ))}
                    </div>
                </div>

                <div className="flex flex-col gap-2">
                    <label className="text-[10px] uppercase font-bold tracking-widest text-muted-foreground">Learning Rate</label>
                    <input 
                        type="range" min="0.001" max="0.5" step="0.001" 
                        value={lr} onChange={(e) => setLrSynced(parseFloat(e.target.value))}
                        className="accent-emerald-500 w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer"
                    />
                    <span className="text-[10px] text-emerald-500 self-end font-mono">{lr.toFixed(3)}</span>
                </div>

                <div className="flex flex-col gap-2">
                    <label className="text-[10px] uppercase font-bold tracking-widest text-muted-foreground">Hidden Neurons</label>
                    <div className="flex items-center gap-3">
                        <button onClick={() => setHiddenSize(Math.max(2, hiddenSize - 2))} className="w-6 h-6 flex items-center justify-center bg-white/5 border border-white/10 rounded-full hover:bg-white/10 text-xs">-</button>
                        <span className="text-sm font-bold font-mono">{hiddenSize}</span>
                        <button onClick={() => setHiddenSize(Math.min(32, hiddenSize + 2))} className="w-6 h-6 flex items-center justify-center bg-white/5 border border-white/10 rounded-full hover:bg-white/10 text-xs">+</button>
                    </div>
                </div>

                <div className="flex items-end justify-end gap-2">
                    <button 
                        onClick={() => setIsPlayingSynced(!isPlayingRef.current)}
                        className={`w-full py-2 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all border ${
                            isPlaying ? 'bg-amber-500/10 border-amber-500/30 text-amber-500 hover:bg-amber-500/20' : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-500 hover:bg-emerald-500/20'
                        }`}
                    >
                        {isPlaying ? 'Pause' : 'Resume'}
                    </button>
                </div>
            </div>
                </>
            )}
        </div>
    );
};
