import React, { useEffect, useRef } from 'react';
import * as wasm from '../../wasm/pkg/gran_prix_wasm';
import { VACUUM_INPUTS, VACUUM_HIDDEN, VACUUM_OUTPUTS } from '../../types';

interface VacuumNetworkVizProps {
    /** WASM Population instance — used to pull the best brain's weights each frame. */
    population: wasm.Population | null;
    /** Fitness array so we can identify the best individual */
    fitnessScores: Float32Array;
}

const INPUT_NAMES = [
    'dust_fwd', 'dust_left', 'dust_right',
    'obs_fwd', 'battery',
    'dist_⚡', 'ang_⚡',
    'sin(θ)', 'cos(θ)',
];
const OUTPUT_NAMES = ['fwd', 'turn_L', 'turn_R'];

/**
 * Real-time neural network weight visualizer for the Smart Vacuum demo.
 *
 * Canvas-based renderer matching WalkerNetworkViz pattern.
 * Connection colour encodes sign (emerald = positive, rose = negative).
 * Connection width encodes magnitude.
 */
export const VacuumNetworkViz: React.FC<VacuumNetworkVizProps> = ({
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

            const layers = [VACUUM_INPUTS, VACUUM_HIDDEN, VACUUM_OUTPUTS];
            const layerX = [width * 0.15, width * 0.5, width * 0.85];
            const nodeRadius = 5;

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

            // ── Nodes + Labels ─────────────────────────────────────────────
            layers.forEach((nodeCount, l) => {
                for (let i = 0; i < nodeCount; i++) {
                    const y = (height / (nodeCount + 1)) * (i + 1);

                    // Node circle
                    ctx.beginPath();
                    ctx.arc(layerX[l], y, nodeRadius, 0, Math.PI * 2);
                    ctx.fillStyle = 'hsl(240 10% 8%)';
                    ctx.strokeStyle =
                        l === 0
                            ? 'rgba(59, 130, 246, 0.7)'   // Input: blue
                            : l === layers.length - 1
                                ? 'rgba(245, 158, 11, 0.7)'  // Output: amber
                                : 'rgba(100, 100, 120, 0.5)'; // Hidden: gray
                    ctx.lineWidth = 1.5;
                    ctx.fill();
                    ctx.stroke();

                    // Label text
                    ctx.font = 'bold 7px Inter, system-ui, sans-serif';
                    if (l === 0 && i < INPUT_NAMES.length) {
                        // Input labels (left-aligned)
                        ctx.fillStyle = 'rgba(140, 160, 200, 0.8)';
                        ctx.textAlign = 'right';
                        ctx.fillText(INPUT_NAMES[i], layerX[l] - nodeRadius - 4, y + 3);
                    } else if (l === layers.length - 1 && i < OUTPUT_NAMES.length) {
                        // Output labels (right-aligned)
                        ctx.fillStyle = 'rgba(245, 180, 80, 0.8)';
                        ctx.textAlign = 'left';
                        ctx.fillText(OUTPUT_NAMES[i], layerX[l] + nodeRadius + 4, y + 3);
                    }
                }
            });

            // Layer labels at bottom
            ctx.fillStyle = 'rgba(150,150,170,0.5)';
            ctx.font = '7px Inter, system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('IN', layerX[0], height - 4);
            ctx.fillText('HIDDEN', layerX[1], height - 4);
            ctx.fillText('OUT', layerX[2], height - 4);

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
                width={300}
                height={320}
                className="bg-black/20 rounded-xl border border-white/5 shadow-inner"
                aria-label="Vacuum neural network weight visualization"
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
