import React, { useEffect, useRef } from 'react';
import { Download, Upload, Code } from 'lucide-react';

interface NetworkVizProps {
    population?: any;
    fitnessScores?: Float32Array;
    weights?: Float32Array | null;
    inputs: number;
    hidden: number[];
    outputs: number;
    inputNames?: string[];
    outputNames?: string[];
    width?: number;
    height?: number;
    onImport?: (weights: Float32Array) => void;
    onExportCCode?: () => void;
}

export const NetworkViz: React.FC<NetworkVizProps> = ({
    population,
    fitnessScores,
    weights,
    inputs,
    hidden,
    outputs,
    inputNames = [],
    outputNames = [],
    width = 300,
    height = 340,
    onImport,
    onExportCCode,
}) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rafRef = useRef<number | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const activeWeightsRef = useRef<Float32Array | null>(null);

    const handleExportJSON = () => {
        if (!activeWeightsRef.current) return;
        const blob = new Blob([JSON.stringify(Array.from(activeWeightsRef.current))], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `neural_weights_${new Date().getTime()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const handleImportClick = () => {
        fileInputRef.current?.click();
    };

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !onImport) return;

        try {
            const text = await file.text();
            const arr = JSON.parse(text);
            if (!Array.isArray(arr)) throw new Error("Invalid format");
            onImport(new Float32Array(arr));
        } catch (err) {
            console.error("Import failed:", err);
            alert("Failed to import weights JSON file.");
        }
        e.target.value = '';
    };

    useEffect(() => {
        if (!canvasRef.current || (!population && !weights)) return;

        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const draw = () => {
            let activeWeights: Float32Array | null = null;

            if (weights) {
                activeWeights = weights;
            } else if (population && fitnessScores) {
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

                try {
                    const flat: number[] = [];
                    if (Array.isArray(snapshot)) {
                        for (const node of snapshot) {
                            if (node.value) {
                                for (const v of node.value) flat.push(v);
                            }
                        }
                    }
                    activeWeights = flat.length > 0 ? new Float32Array(flat) : null;
                } catch {
                    activeWeights = null;
                }
            }
            activeWeightsRef.current = activeWeights;

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
                        const weight = activeWeights ? (activeWeights[wIdx] ?? 0) : 0;
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
    }, [population, fitnessScores, weights, inputs, hidden, outputs, inputNames, outputNames]);

    return (
        <div className="flex flex-col items-center gap-4">
            <div className="w-full flex items-center justify-between">
                <h3 className="text-xs font-black text-foreground uppercase tracking-[0.2em] flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                    Neural Weights
                </h3>
                {activeWeightsRef.current && (
                    <div className="text-[8px] font-mono text-muted-foreground uppercase opacity-50">
                        {activeWeightsRef.current.length} Params
                    </div>
                )}
            </div>

            <canvas
                ref={canvasRef}
                width={width}
                height={height}
                className="w-full h-auto dark:bg-black/10 bg-gray-100 rounded-xl border-[0.5px] border-border/50"
            />

            <div className="flex gap-4">
                <div className="flex items-center gap-1.5">
                    <span className="w-2 h-0.5 rounded-full bg-emerald-500 opacity-70 inline-block" />
                    <span className="text-[7px] text-muted-foreground uppercase tracking-widest font-bold">Positive</span>
                </div>
                <div className="flex items-center gap-1.5">
                    <span className="w-2 h-0.5 rounded-full bg-rose-500 opacity-70 inline-block" />
                    <span className="text-[7px] text-muted-foreground uppercase tracking-widest font-bold">Negative</span>
                </div>
            </div>

            <div className="w-full grid grid-cols-2 gap-2">
                <button
                    onClick={handleExportJSON}
                    className="flex items-center justify-center gap-2 px-3 py-2 bg-muted/40 hover:bg-muted/60 rounded-lg border border-border/50 transition-all group"
                >
                    <Download size={12} className="text-blue-400" />
                    <span className="text-[8px] font-bold uppercase tracking-wider">Export</span>
                </button>

                <button
                    onClick={handleImportClick}
                    className="flex items-center justify-center gap-2 px-3 py-2 bg-muted/40 hover:bg-muted/60 rounded-lg border border-border/50 transition-all group"
                >
                    <Upload size={12} className="text-amber-400" />
                    <span className="text-[8px] font-bold uppercase tracking-wider">Import</span>
                </button>

                {onExportCCode && (
                    <button
                        onClick={onExportCCode}
                        className="col-span-2 flex items-center justify-center gap-2 px-3 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 rounded-lg border border-emerald-500/20 transition-all group"
                    >
                        <Code size={12} className="text-emerald-500" />
                        <span className="text-[8px] font-bold uppercase tracking-wider text-emerald-500">Generate Hardware C Code</span>
                    </button>
                )}
            </div>

            <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                accept=".json"
                className="hidden"
            />
        </div>
    );
};
