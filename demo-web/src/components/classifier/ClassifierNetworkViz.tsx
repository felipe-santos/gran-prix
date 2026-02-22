import React, { useEffect, useRef } from 'react';
import * as wasm from '../../wasm/pkg/gran_prix_wasm';

interface ClassifierNetworkVizProps {
    trainer: wasm.Trainer | null;
    hiddenSize: number;
    inputDim?: number;
}

export const ClassifierNetworkViz: React.FC<ClassifierNetworkVizProps> = ({ trainer, hiddenSize }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        if (!trainer || !canvasRef.current) return;
        const ctx = canvasRef.current.getContext('2d');
        if (!ctx) return;

        let rafId: number;
        const draw = () => {
            const weights = trainer.get_weights();
            if (!weights || !canvasRef.current) return;

            const { width, height } = canvasRef.current;
            ctx.clearRect(0, 0, width, height);
            const effectiveInputDim = inputDim || 2;
            const layers = [effectiveInputDim, hiddenSize, 1];
            const layerX = [width * 0.2, width * 0.5, width * 0.8];
            const nodeRadius = 10;

            // Draw Connections
            let wIdx = 0;
            for (let l = 0; l < layers.length - 1; l++) {
                const currentLayerNodes = layers[l];
                const nextLayerNodes = layers[l + 1];

                for (let i = 0; i < currentLayerNodes; i++) {
                    const y1 = (height / (currentLayerNodes + 1)) * (i + 1);
                    for (let j = 0; j < nextLayerNodes; j++) {
                        const y2 = (height / (nextLayerNodes + 1)) * (j + 1);
                        const weight = weights[wIdx++];

                        ctx.beginPath();
                        ctx.moveTo(layerX[l], y1);
                        ctx.lineTo(layerX[l + 1], y2);
                        ctx.lineWidth = Math.min(Math.abs(weight) * 3, 4);
                        ctx.strokeStyle = weight > 0
                            ? `rgba(52, 211, 153, ${0.1 + Math.abs(weight)})`
                            : `rgba(244, 63, 94, ${0.1 + Math.abs(weight)})`;
                        ctx.stroke();
                    }
                }
                wIdx += nextLayerNodes; // Skip biases
            }

            // Draw Nodes
            layers.forEach((nodeCount, l) => {
                for (let i = 0; i < nodeCount; i++) {
                    const y = (height / (nodeCount + 1)) * (i + 1);
                    ctx.beginPath();
                    ctx.arc(layerX[l], y, nodeRadius, 0, Math.PI * 2);
                    ctx.fillStyle = '#1e1e24';
                    ctx.shadowBlur = 10;
                    ctx.shadowColor = 'rgba(0,0,0,0.5)';
                    ctx.fill();

                    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
                    ctx.lineWidth = 1;
                    ctx.stroke();
                    ctx.shadowBlur = 0;
                }
            });

            rafId = requestAnimationFrame(draw);
        };

        rafId = requestAnimationFrame(draw);
        return () => cancelAnimationFrame(rafId);
    }, [trainer, hiddenSize]);

    return (
        <div className="bg-card/40 border border-border/50 rounded-[2rem] overflow-hidden backdrop-blur-xl shadow-2xl">
            <div className="p-6 border-b border-border/50 bg-card/60">
                <h3 className="text-xs font-black text-foreground uppercase tracking-[0.2em] flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                    Neural Weights
                </h3>
            </div>
            <div className="p-6">
                <canvas
                    ref={canvasRef}
                    width={320}
                    height={280}
                    className="w-full h-auto bg-black/10 rounded-xl"
                />
            </div>
        </div>
    );
};
