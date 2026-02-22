import React from 'react';
import { Cpu, Binary } from 'lucide-react';

interface WeightsViewerProps {
    weights: Float32Array | null;
    hiddenLayers: number[];
    inputDim: number;
}

export const WeightsViewer: React.FC<WeightsViewerProps> = ({ weights, hiddenLayers, inputDim }) => {
    if (!weights || weights.length === 0) {
        return (
            <div className="bg-card/50 border border-border rounded-2xl overflow-hidden backdrop-blur-md p-6 flex flex-col items-center justify-center text-muted-foreground font-mono text-[10px] gap-3 min-h-[200px]">
                <Binary size={20} className="opacity-20 text-cyan-500" />
                <span className="uppercase tracking-widest text-center">Neural Core Offline<br />Initialize to visualize tensors</span>
            </div>
        );
    }

    const totalParams = weights.length;
    const blocks: { title: string; data: number[]; cols: number }[] = [];
    let currentIdx = 0;
    let prevSize = inputDim;

    hiddenLayers.forEach((hSize, idx) => {
        const wCount = prevSize * hSize;
        const bCount = hSize;
        if (currentIdx + wCount + bCount <= weights.length) {
            blocks.push({ title: `L${idx + 1} Weights`, data: Array.from(weights.slice(currentIdx, currentIdx + wCount)), cols: hSize });
            currentIdx += wCount;
            blocks.push({ title: `L${idx + 1} Biases`, data: Array.from(weights.slice(currentIdx, currentIdx + bCount)), cols: hSize });
            currentIdx += bCount;
        }
        prevSize = hSize;
    });

    const wOutCount = prevSize * 1;
    const bOutCount = 1;
    if (currentIdx + wOutCount + bOutCount <= weights.length) {
        blocks.push({ title: `Output Weights`, data: Array.from(weights.slice(currentIdx, currentIdx + wOutCount)), cols: 1 });
        currentIdx += wOutCount;
        blocks.push({ title: `Output Bias`, data: Array.from(weights.slice(currentIdx, currentIdx + bOutCount)), cols: 1 });
    }

    return (
        <div className="bg-card/50 border border-border rounded-2xl overflow-hidden backdrop-blur-md flex flex-col shadow-xl">
            <div className="p-4 border-b border-border bg-card/80 flex items-center justify-between">
                <div className="flex flex-col">
                    <h3 className="text-sm font-bold text-foreground uppercase tracking-tighter flex items-center gap-2">
                        <Cpu size={14} className="text-cyan-500" /> Tensor Map
                    </h3>
                    <p className="text-[9px] text-muted-foreground font-mono mt-0.5 uppercase">{totalParams} Parameters</p>
                </div>
                <div className="px-2 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-[8px] font-black text-cyan-500 uppercase tracking-widest">Live</div>
            </div>

            <div className="p-5 max-h-[600px] overflow-y-auto custom-scrollbar">
                {blocks.map((b, bIdx) => (
                    <div key={bIdx} className="mb-6 last:mb-0">
                        <div className="flex justify-between items-center mb-2">
                            <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">{b.title}</span>
                            <span className="text-[8px] font-mono text-muted-foreground/40">[{b.data.length}]</span>
                        </div>
                        <div
                            className="grid gap-[2px] bg-muted/20 p-1 rounded-lg border border-border/10"
                            style={{ gridTemplateColumns: `repeat(${b.cols}, minmax(0, 1fr))` }}
                        >
                            {b.data.map((w, i) => {
                                const rawNorm = Math.max(-1, Math.min(1, w / 2));
                                const isPositive = w > 0;
                                const opacity = Math.abs(rawNorm);
                                return (
                                    <div
                                        key={i}
                                        className="h-4 rounded-[1px] relative group overflow-hidden"
                                        style={{ backgroundColor: isPositive ? `rgba(16, 185, 129, ${Math.max(0.05, opacity)})` : `rgba(244, 63, 94, ${Math.max(0.05, opacity)})` }}
                                    >
                                        <div className="absolute inset-0 opacity-0 group-hover:opacity-100 flex items-center justify-center bg-background/80 text-[6px] font-mono z-10 transition-opacity">
                                            {w.toFixed(1)}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ))}
            </div>

            <div className="p-3 bg-muted/20 border-t border-border text-[7px] text-muted-foreground font-mono text-center tracking-widest uppercase">
                Kernel Space Visualization
            </div>
        </div>
    );
};
