import React, { useEffect, useRef } from 'react';

interface NetworkVizProps {
    population: any;
    fitnessScores: Float32Array;
    inputs: number;
    hidden: number[];
    outputs: number;
    inputNames?: string[];
    outputNames?: string[];
    width?: number;
    height?: number;
}

export const NetworkViz: React.FC<NetworkVizProps> = ({
    population,
    fitnessScores,
    inputs,
    hidden,
    outputs,
    inputNames = [],
    outputNames = [],
    width = 300,
    height = 340,
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

            ctx.clearRect(0, 0, canvas.width, canvas.height);

            const layers = [inputs, ...hidden, outputs];
            const layerX = layers.map((_, l) =>
                (canvas.width * 0.15) + (l * (canvas.width * 0.7)) / (layers.length - 1)
            );
            const nodeRadius = 5;

            // ── Connections ────────────────────────────────────────────────
            let wIdx = 0;
            for (let l = 0; l < layers.length - 1; l++) {
                const curNodes = layers[l];
                const nextNodes = layers[l + 1];

                for (let i = 0; i < curNodes; i++) {
                    const y1 = (canvas.height / (curNodes + 1)) * (i + 1);
                    for (let j = 0; j < nextNodes; j++) {
                        const y2 = (canvas.height / (nextNodes + 1)) * (j + 1);
                        const weight = weights ? (weights[wIdx] ?? 0) : 0;
                        wIdx++;

                        const mag = Math.min(Math.abs(weight), 1.5);
                        const alpha = 0.05 + mag * 0.4;
                        ctx.beginPath();
                        ctx.moveTo(layerX[l], y1);
                        ctx.lineTo(layerX[l + 1], y2);
                        ctx.lineWidth = Math.max(0.2, mag * 1.5);
                        ctx.strokeStyle = weight >= 0
                            ? `rgba(16, 185, 129, ${alpha})`
                            : `rgba(244, 63, 94, ${alpha})`;
                        ctx.stroke();
                    }
                }
                wIdx += nextNodes; // biases
            }

            // ── Nodes + Labels ─────────────────────────────────────────────
            layers.forEach((nodeCount, l) => {
                for (let i = 0; i < nodeCount; i++) {
                    const y = (canvas.height / (nodeCount + 1)) * (i + 1);

                    ctx.beginPath();
                    ctx.arc(layerX[l], y, nodeRadius, 0, Math.PI * 2);
                    ctx.fillStyle = 'hsl(240 10% 8%)';
                    ctx.strokeStyle = l === 0
                        ? 'rgba(59, 130, 246, 0.7)'
                        : l === layers.length - 1
                            ? 'rgba(245, 158, 11, 0.7)'
                            : 'rgba(100, 100, 120, 0.5)';
                    ctx.lineWidth = 1.2;
                    ctx.fill();
                    ctx.stroke();

                    // Text labels
                    ctx.font = 'bold 7px Inter, system-ui, sans-serif';
                    if (l === 0 && i < inputNames.length) {
                        ctx.fillStyle = 'rgba(140, 160, 200, 0.8)';
                        ctx.textAlign = 'right';
                        ctx.fillText(inputNames[i], layerX[l] - nodeRadius - 4, y + 3);
                    } else if (l === layers.length - 1 && i < outputNames.length) {
                        ctx.fillStyle = 'rgba(245, 180, 80, 0.8)';
                        ctx.textAlign = 'left';
                        ctx.fillText(outputNames[i], layerX[l] + nodeRadius + 4, y + 3);
                    }
                }

                // Layer indicator labels at the bottom
                ctx.fillStyle = 'rgba(150,150,170,0.5)';
                ctx.font = '7px Inter, system-ui, sans-serif';
                ctx.textAlign = 'center';
                let label = '';
                if (l === 0) label = 'IN';
                else if (l === layers.length - 1) label = 'OUT';
                else label = layers.length > 3 ? `H${l}` : 'HIDDEN';
                ctx.fillText(label, layerX[l], canvas.height - 4);
            });

            rafRef.current = requestAnimationFrame(draw);
        };

        rafRef.current = requestAnimationFrame(draw);
        return () => {
            if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
        };
    }, [population, fitnessScores, inputs, hidden, outputs, inputNames, outputNames]);

    return (
        <div className="flex flex-col items-center gap-2">
            <span className="text-[9px] uppercase font-bold tracking-[0.3em] text-muted-foreground">
                Network Weights
            </span>
            <canvas
                ref={canvasRef}
                width={width}
                height={height}
                className="bg-black/20 rounded-xl border border-white/5 shadow-inner"
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
