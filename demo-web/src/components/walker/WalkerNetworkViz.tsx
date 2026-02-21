import React, { useEffect, useRef } from 'react';
import * as wasm from '../../wasm/pkg/gran_prix_wasm';
import { WALKER_INPUTS, WALKER_HIDDEN, WALKER_OUTPUTS } from '../../types';

interface WalkerNetworkVizProps {
    /** WASM Population instance — used to pull the best brain's weights each frame. */
    population: wasm.Population | null;
    /** Fitness array so we can identify the best individual */
    fitnessScores: Float32Array;
}

/**
 * Real-time neural network weight visualizer for the Bipedal Walker demo.
 *
 * Draws connections and nodes on a canvas that is refreshed every animation frame.
 * Connection colour encodes sign (emerald = positive, rose = negative).
 * Connection width encodes magnitude.
 *
 * Adapted from FlappyNetworkViz for the 10 → 12 → 4 network topology.
 */
export const WalkerNetworkViz: React.FC<WalkerNetworkVizProps> = ({
    population,
    fitnessScores,
}) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rafRef = useRef<number | null>(null);

    useEffect(() => {
        if (!population || !canvasRef.current) return;

        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const draw = () => {
            let snapshot: any;
            try {
                snapshot = population.get_best_brain_snapshot(fitnessScores);
            } catch {
                rafRef.current = requestAnimationFrame(draw);
                return;
            }

            if (!snapshot) {
                rafRef.current = requestAnimationFrame(draw);
                return;
            }

            // Extract flat weight array from snapshot
            let weights: Float32Array | null = null;
            try {
                const flat: number[] = [];
                if (Array.isArray(snapshot)) {
                    for (const node of snapshot) {
                        if (node.value) {
                            for (const v of node.value) flat.push(v);
                        }
                    }
                }
                weights = flat.length > 0 ? new Float32Array(flat) : null;
            } catch {
                weights = null;
            }

            const { width, height } = canvas;
            ctx.clearRect(0, 0, width, height);

            const layers = [WALKER_INPUTS, WALKER_HIDDEN, WALKER_OUTPUTS];
            const layerX = [width * 0.12, width * 0.5, width * 0.88];
            const nodeRadius = 6; // Smaller to fit 10 input nodes

            // ── Connections ────────────────────────────────────────────────
            let wIdx = 0;
            for (let l = 0; l < layers.length - 1; l++) {
                const curNodes = layers[l];
                const nextNodes = layers[l + 1];

                for (let i = 0; i < curNodes; i++) {
                    const y1 = (height / (curNodes + 1)) * (i + 1);
                    for (let j = 0; j < nextNodes; j++) {
                        const y2 = (height / (nextNodes + 1)) * (j + 1);
                        const weight = weights ? (weights[wIdx] ?? 0) : 0;
                        wIdx++;

                        const mag = Math.min(Math.abs(weight), 1.5);
                        const alpha = 0.08 + mag * 0.5;
                        ctx.beginPath();
                        ctx.moveTo(layerX[l], y1);
                        ctx.lineTo(layerX[l + 1], y2);
                        ctx.lineWidth = Math.max(0.3, mag * 2);
                        ctx.strokeStyle =
                            weight >= 0
                                ? `rgba(16, 185, 129, ${alpha})`
                                : `rgba(244, 63, 94, ${alpha})`;
                        ctx.stroke();
                    }
                    // Skip biases
                    wIdx += nextNodes;
                }
            }

            // ── Nodes ──────────────────────────────────────────────────────
            const layerLabels = ['IN', 'H', 'OUT'];
            layers.forEach((nodeCount, l) => {
                for (let i = 0; i < nodeCount; i++) {
                    const y = (height / (nodeCount + 1)) * (i + 1);
                    ctx.beginPath();
                    ctx.arc(layerX[l], y, nodeRadius, 0, Math.PI * 2);
                    ctx.fillStyle = 'hsl(240 10% 8%)';
                    ctx.strokeStyle =
                        l === 0
                            ? 'rgba(16, 185, 129, 0.6)'
                            : l === layers.length - 1
                                ? 'rgba(59, 130, 246, 0.6)'
                                : 'rgba(100, 100, 120, 0.5)';
                    ctx.lineWidth = 1.5;
                    ctx.fill();
                    ctx.stroke();
                }
                ctx.fillStyle = 'rgba(150,150,170,0.5)';
                ctx.font = '7px Inter, system-ui, sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText(layerLabels[l], layerX[l], height - 4);
            });

            rafRef.current = requestAnimationFrame(draw);
        };

        rafRef.current = requestAnimationFrame(draw);
        return () => {
            if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
        };
    }, [population, fitnessScores]);

    return (
        <div className="flex flex-col items-center gap-2">
            <span className="text-[9px] uppercase font-bold tracking-[0.3em] text-muted-foreground">
                Network Weights — Live
            </span>
            <canvas
                ref={canvasRef}
                width={280}
                height={260}
                className="bg-black/20 rounded-xl border border-white/5 shadow-inner"
                aria-label="Walker neural network weight visualization"
            />
            <div className="flex gap-4 mt-1">
                <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-0.5 rounded-full bg-emerald-500 opacity-70 inline-block" />
                    <span className="text-[8px] text-muted-foreground uppercase tracking-widest">Positive</span>
                </div>
                <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-0.5 rounded-full bg-rose-500 opacity-70 inline-block" />
                    <span className="text-[8px] text-muted-foreground uppercase tracking-widest">Negative</span>
                </div>
            </div>
        </div>
    );
};
