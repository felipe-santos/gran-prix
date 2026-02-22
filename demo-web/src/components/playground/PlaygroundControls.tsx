import React from 'react';
import { Upload, Download, Trash2, Play, Square } from 'lucide-react';

interface PlaygroundControlsProps {
    isTraining: boolean;
    onToggleTraining: () => void;
    onClearPoints: () => void;
    onExportWeights: () => void;
    onImportWeights: (file: File) => void;
    loss: number;
    learningRate: number;
    onLearningRateChange: (lr: number) => void;
    currentLabel: number;
    onLabelChange: (label: number) => void;
    hiddenLayers: number[];
    onAddLayer: () => void;
    onRemoveLayer: (index: number) => void;
    onUpdateNeurons: (index: number, delta: number) => void;
}

export const PlaygroundControls: React.FC<PlaygroundControlsProps> = ({
    isTraining,
    onToggleTraining,
    onClearPoints,
    onExportWeights,
    onImportWeights,
    loss,
    learningRate,
    onLearningRateChange,
    currentLabel,
    onLabelChange,
    hiddenLayers,
    onAddLayer,
    onRemoveLayer,
    onUpdateNeurons
}) => {
    return (
        <div className="bg-card/40 backdrop-blur-sm border border-white/5 rounded-2xl p-6 flex flex-col gap-6">

            <div className="flex items-center justify-between border-b border-white/5 pb-4">
                <span className="text-sm text-muted-foreground uppercase tracking-widest font-mono">Current Loss</span>
                <span className={`text-xl font-mono tabular-nums ${loss < 0.1 ? 'text-emerald-400' : 'text-cyan-400'}`}>
                    {loss.toFixed(4)}
                </span>
            </div>

            {/* Architecture Controls */}
            <div className="space-y-4 border-b border-white/5 pb-6">
                <div className="flex justify-between items-center">
                    <label className="text-sm font-medium text-foreground/80 uppercase tracking-tighter">Architecture</label>
                    <button
                        onClick={onAddLayer}
                        disabled={hiddenLayers.length >= 5}
                        className="text-[10px] bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 px-2 py-1 rounded hover:bg-cyan-500/20 disabled:opacity-30"
                    >
                        + Add Layer
                    </button>
                </div>

                <div className="space-y-3">
                    {hiddenLayers.map((neurons, idx) => (
                        <div key={idx} className="flex items-center gap-3 bg-black/20 p-2 rounded-xl border border-white/5">
                            <span className="text-[10px] font-mono text-white/30 w-12 text-center">Layer {idx + 1}</span>
                            <div className="flex-1 flex items-center justify-center gap-4">
                                <button
                                    onClick={() => onUpdateNeurons(idx, -1)}
                                    className="w-6 h-6 rounded bg-white/5 flex items-center justify-center hover:bg-white/10 text-white/60"
                                >-</button>
                                <span className="text-sm font-mono w-4 text-center">{neurons}</span>
                                <button
                                    onClick={() => onUpdateNeurons(idx, 1)}
                                    className="w-6 h-6 rounded bg-white/5 flex items-center justify-center hover:bg-white/10 text-white/60"
                                >+</button>
                            </div>
                            <button
                                onClick={() => onRemoveLayer(idx)}
                                className="text-rose-500/40 hover:text-rose-500 px-2"
                            >
                                <Trash2 size={14} />
                            </button>
                        </div>
                    ))}
                    {hiddenLayers.length === 0 && (
                        <div className="text-center py-4 text-[10px] text-white/20 uppercase font-mono">Linear Model (No hidden layers)</div>
                    )}
                </div>
            </div>

            <div className="space-y-4">
                <div className="flex justify-between items-center">
                    <label className="text-sm font-medium text-foreground/80">Input Feature Class (Click Canvas)</label>
                    <div className="flex bg-black/40 p-1 rounded-lg border border-white/5">
                        <button
                            onClick={() => onLabelChange(0)}
                            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${currentLabel === 0 ? 'bg-blue-500 text-white shadow-lg' : 'text-blue-400 hover:text-blue-300'}`}
                        >
                            Class 0 (Blue)
                        </button>
                        <button
                            onClick={() => onLabelChange(1)}
                            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${currentLabel === 1 ? 'bg-orange-500 text-white shadow-lg' : 'text-orange-400 hover:text-orange-300'}`}
                        >
                            Class 1 (Orange)
                        </button>
                    </div>
                </div>

                <div className="space-y-2">
                    <div className="flex justify-between">
                        <label className="text-sm font-medium text-foreground/80">Learning Rate</label>
                        <span className="text-sm font-mono text-cyan-400">{learningRate.toFixed(3)}</span>
                    </div>
                    <input
                        type="range"
                        min="0.001"
                        max="0.5"
                        step="0.001"
                        value={learningRate}
                        onChange={(e) => onLearningRateChange(parseFloat(e.target.value))}
                        className="w-full accent-cyan-500"
                    />
                </div>
            </div>

            <div className="grid grid-cols-2 gap-3 pt-4 border-t border-white/5">
                <button
                    onClick={onToggleTraining}
                    className={`col-span-2 flex items-center justify-center gap-2 py-3 px-4 rounded-xl font-medium transition-all ${isTraining
                        ? 'bg-rose-500/10 text-rose-500 hover:bg-rose-500/20 border border-rose-500/30'
                        : 'bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 border border-emerald-500/30'
                        }`}
                >
                    {isTraining ? <><Square size={18} /> Stop Training</> : <><Play size={18} /> Start Training</>}
                </button>

                <button
                    onClick={onClearPoints}
                    className="flex items-center justify-center gap-2 py-2 px-4 rounded-xl text-sm font-medium bg-white/5 hover:bg-white/10 text-foreground transition-all"
                >
                    <Trash2 size={16} /> Clear Canvas
                </button>

                <button
                    onClick={onExportWeights}
                    className="flex items-center justify-center gap-2 py-2 px-4 rounded-xl text-sm font-medium bg-white/5 hover:bg-white/10 text-cyan-400 transition-all border border-cyan-500/20"
                >
                    <Download size={16} /> Export Weights
                </button>

                <label className="col-span-2 flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-sm font-medium bg-white/5 hover:bg-white/10 text-emerald-400 transition-all cursor-pointer border border-emerald-500/20 border-dashed">
                    <Upload size={16} /> Import Weights
                    <input
                        type="file"
                        accept="application/json"
                        className="hidden"
                        onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) onImportWeights(file);
                        }}
                    />
                </label>
            </div>
        </div>
    );
};
