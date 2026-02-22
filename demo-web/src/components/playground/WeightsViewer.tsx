import React from 'react';

interface WeightsViewerProps {
    weights: Float32Array | null;
    hiddenLayers: number[];
}

export const WeightsViewer: React.FC<WeightsViewerProps> = ({ weights, hiddenLayers }) => {
    if (!weights || weights.length === 0) {
        return (
            <div className="bg-card/40 border border-white/5 rounded-2xl p-6 h-full flex items-center justify-center text-muted-foreground font-mono text-sm">
                Initialize network to view weights
            </div>
        );
    }

    const totalParams = weights.length;

    // Slicing logic based on trainer.rs graph construction order:
    // For each layer: [Weights, Biases]
    // Input is 2, Output is 1.

    const blocks: { title: string; data: number[]; cols: number }[] = [];
    let currentIdx = 0;
    let prevSize = 2; // Input size

    // Process Hidden Layers
    hiddenLayers.forEach((hSize, idx) => {
        const wCount = prevSize * hSize;
        const bCount = hSize;

        if (currentIdx + wCount + bCount <= weights.length) {
            blocks.push({
                title: `Layer ${idx + 1} Weights (${prevSize}x${hSize})`,
                data: Array.from(weights.slice(currentIdx, currentIdx + wCount)),
                cols: hSize
            });
            currentIdx += wCount;

            blocks.push({
                title: `Layer ${idx + 1} Biases (1x${hSize})`,
                data: Array.from(weights.slice(currentIdx, currentIdx + bCount)),
                cols: hSize
            });
            currentIdx += bCount;
        }
        prevSize = hSize;
    });

    // Process Output Layer
    const wOutCount = prevSize * 1; // Output size is 1
    const bOutCount = 1;

    if (currentIdx + wOutCount + bOutCount <= weights.length) {
        blocks.push({
            title: `Output Weights (${prevSize}x1)`,
            data: Array.from(weights.slice(currentIdx, currentIdx + wOutCount)),
            cols: 1
        });
        currentIdx += wOutCount;

        blocks.push({
            title: `Output Bias (1x1)`,
            data: Array.from(weights.slice(currentIdx, currentIdx + bOutCount)),
            cols: 1
        });
    }

    const renderWeightBlock = (title: string, data: number[], cols: number) => {
        return (
            <div key={title} className="mb-6 last:mb-0">
                <h4 className="text-xs font-mono text-cyan-400 mb-2 uppercase tracking-widest">{title} <span className="text-white/30 text-[10px]">({data.length})</span></h4>
                <div
                    className="grid gap-[2px] bg-white/5 p-[2px] rounded-lg"
                    style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
                >
                    {data.map((w, i) => {
                        // Normalize color intensity based on weight magnitude
                        const rawNorm = Math.max(-1, Math.min(1, w / 2));
                        const isPositive = w > 0;
                        const opacity = Math.abs(rawNorm);

                        return (
                            <div
                                key={i}
                                className="h-6 rounded-sm flex items-center justify-center text-[8px] font-mono text-white/70 overflow-hidden relative group"
                                style={{
                                    backgroundColor: isPositive
                                        ? `rgba(16, 185, 129, ${Math.max(0.1, opacity)})` // Emerald for positive
                                        : `rgba(244, 63, 94, ${Math.max(0.1, opacity)})`  // Rose for negative
                                }}
                            >
                                <span className="opacity-0 group-hover:opacity-100 transition-opacity z-10">{w.toFixed(2)}</span>
                            </div>
                        );
                    })}
                </div>
            </div>
        );
    };

    return (
        <div className="bg-card/40 backdrop-blur-sm border border-white/5 rounded-2xl p-6 h-full flex flex-col">
            <div className="flex items-center justify-between mb-6 pb-4 border-b border-white/5">
                <h3 className="font-semibold text-lg text-white">Network Architecture</h3>
                <span className="text-xs bg-cyan-500/10 text-cyan-400 px-2 py-1 rounded-md font-mono border border-cyan-500/20">{totalParams} Params</span>
            </div>

            <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
                {blocks.map(b => renderWeightBlock(b.title, b.data, b.cols))}
            </div>
        </div>
    );
};
