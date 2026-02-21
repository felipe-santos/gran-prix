import React, { useEffect, useRef } from 'react';
import * as wasm from '../../wasm/pkg/gran_prix_wasm';

interface PredatorPreyNetworkVizProps {
    population: wasm.Population | null;
    fitnessScores: Float32Array;
    inputSize: number;
    hiddenSize: number;
    outputSize: number;
    title: string;
    themeColor: string; // Tailwind class like "text-rose-500" or custom color
    nodeColor: string;  // Positive output trace color
}

/**
 * Real-time neural network weight visualizer for Predator Prey demo.
 */
export const PredatorPreyNetworkViz: React.FC<PredatorPreyNetworkVizProps> = ({
    population,
    fitnessScores,
    inputSize,
    hiddenSize,
    outputSize,
    title,
    themeColor,
    nodeColor,
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

            const layers = [inputSize, hiddenSize, outputSize];
            const layerX = [width * 0.15, width * 0.5, width * 0.85];
            const nodeRadius = 8; // slightly smaller for 7 inputs

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
                        const alpha = 0.1 + mag * 0.6;
                        ctx.beginPath();
                        ctx.moveTo(layerX[l], y1);
                        ctx.lineTo(layerX[l + 1], y2);
                        ctx.lineWidth = Math.max(0.5, mag * 2.5);
                        ctx.strokeStyle =
                            weight >= 0
                                ? `rgba(16, 185, 129, ${alpha})` // emerald
                                : `rgba(244, 63, 94, ${alpha})`; // rose
                        ctx.stroke();
                    }
                    wIdx += nextNodes;
                }
            }

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
                                ? nodeColor
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
    }, [population, fitnessScores, inputSize, hiddenSize, outputSize, nodeColor]);

    return (
        <div className="flex flex-col items-center gap-2">
            <span className={`text-[9px] uppercase font-bold tracking-[0.3em] ${themeColor}`}>
                {title} Live
            </span>
            <canvas
                ref={canvasRef}
                width={260}
                height={200}
                className="bg-black/20 rounded-xl border border-white/5 shadow-inner w-full"
                aria-label={`${title} weight visualization`}
            />
        </div>
    );
};
