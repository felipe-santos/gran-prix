import React, { useState } from 'react';
import { Upload, Download, Trash2, Play, Square, Plus, Database, GraduationCap, Settings2, Activity } from 'lucide-react';
import { PRESETS } from './PlaygroundPresets';

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
    onExportDataset: () => void;
    onImportDataset: (file: File) => void;
    onAddManualPoint: (x: number, y: number, label: number) => void;
    onLoadPreset: (id: string) => void;
    currentPresetId: string | null;
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
    onUpdateNeurons,
    onExportDataset,
    onImportDataset,
    onAddManualPoint,
    onLoadPreset,
    currentPresetId
}) => {
    const [manualX, setManualX] = useState<string>("0");
    const [manualY, setManualY] = useState<string>("0");

    const handleManualAdd = () => {
        const x = parseFloat(manualX);
        const y = parseFloat(manualY);
        if (!isNaN(x) && !isNaN(y)) {
            onAddManualPoint(x, y, currentLabel);
        }
    };

    return (
        <div className="bg-card/50 border border-border rounded-2xl overflow-hidden backdrop-blur-md flex flex-col shadow-xl">
            {/* Simulation Header */}
            <div className="p-4 border-b border-border bg-card/80 flex items-center justify-between">
                <div className="flex flex-col">
                    <h3 className="text-sm font-bold text-foreground uppercase tracking-tighter flex items-center gap-2">
                        <Activity size={14} className="text-cyan-500" /> Training Status
                    </h3>
                    <p className="text-[9px] text-muted-foreground font-mono mt-0.5 uppercase">Network Batch Gradient</p>
                </div>
                <span className={`text-lg font-mono tabular-nums font-bold ${loss < 0.1 ? 'text-emerald-400' : 'text-cyan-400'}`}>
                    {loss.toFixed(4)}
                </span>
            </div>

            <div className="p-5 space-y-6">
                {/* Presets Selector */}
                <div className="space-y-3">
                    <div className="flex items-center gap-2 text-muted-foreground">
                        <GraduationCap size={14} />
                        <label className="text-[9px] font-bold uppercase tracking-widest">Scenario Presets</label>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        {PRESETS.map(preset => (
                            <button
                                key={preset.id}
                                onClick={() => onLoadPreset(preset.id)}
                                className={`px-2 py-2 rounded-lg text-[9px] font-bold font-mono border transition-all ${currentPresetId === preset.id
                                    ? 'bg-cyan-500/10 border-cyan-500/50 text-cyan-400'
                                    : 'bg-muted/30 border-transparent text-muted-foreground hover:bg-muted/50 hover:border-border'
                                    }`}
                            >
                                {preset.name}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Architecture Controls */}
                <div className="space-y-3 pt-2 border-t border-border/50">
                    <div className="flex justify-between items-center text-muted-foreground">
                        <div className="flex items-center gap-2">
                            <Settings2 size={14} />
                            <label className="text-[9px] font-bold uppercase tracking-widest">Topology</label>
                        </div>
                        <button
                            onClick={onAddLayer}
                            disabled={hiddenLayers.length >= 5}
                            className="text-[9px] bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 px-2 py-0.5 rounded-full font-bold hover:bg-cyan-500/20 transition-all disabled:opacity-30"
                        >
                            + LAYER
                        </button>
                    </div>

                    <div className="space-y-1.5">
                        {hiddenLayers.map((neurons, idx) => (
                            <div key={idx} className="flex items-center gap-2 bg-muted/20 p-1 pl-3 rounded-lg border border-border/10">
                                <span className="text-[9px] font-bold font-mono text-muted-foreground/50 uppercase tracking-tighter">L{idx + 1}</span>
                                <div className="flex-1 flex items-center justify-center gap-3">
                                    <button
                                        onClick={() => onUpdateNeurons(idx, -1)}
                                        className="w-6 h-6 rounded bg-muted/50 flex items-center justify-center hover:bg-muted text-foreground/70 transition-colors"
                                    >-</button>
                                    <span className="text-[11px] font-bold font-mono w-4 text-center text-foreground/90">{neurons}</span>
                                    <button
                                        onClick={() => onUpdateNeurons(idx, 1)}
                                        className="w-6 h-6 rounded bg-muted/50 flex items-center justify-center hover:bg-muted text-foreground/70 transition-colors"
                                    >+</button>
                                </div>
                                <button
                                    onClick={() => onRemoveLayer(idx)}
                                    className="w-6 h-6 flex items-center justify-center text-rose-500/40 hover:text-rose-500 transition-colors"
                                >
                                    <Trash2 size={12} />
                                </button>
                            </div>
                        ))}
                        {hiddenLayers.length === 0 && (
                            <div className="text-center py-4 bg-muted/10 border border-dashed border-border/20 rounded-lg text-[9px] text-muted-foreground/50 uppercase font-bold tracking-widest">Linear Classifier</div>
                        )}
                    </div>
                </div>

                {/* Hyperparams & Manual Entry */}
                <div className="space-y-4 pt-2 border-t border-border/50">
                    <div className="grid grid-cols-2 gap-2">
                        <button
                            onClick={() => onLabelChange(0)}
                            className={`py-2 rounded-lg text-[10px] font-bold font-mono transition-all border ${currentLabel === 0 ? 'bg-blue-500 border-blue-600 text-white' : 'bg-muted/30 border-transparent text-blue-400/60 hover:bg-muted/50'}`}
                        >
                            CLASS 0
                        </button>
                        <button
                            onClick={() => onLabelChange(1)}
                            className={`py-2 rounded-lg text-[10px] font-bold font-mono transition-all border ${currentLabel === 1 ? 'bg-orange-500 border-orange-600 text-white' : 'bg-muted/30 border-transparent text-orange-400/60 hover:bg-muted/50'}`}
                        >
                            CLASS 1
                        </button>
                    </div>

                    <div className="space-y-2">
                        <div className="flex justify-between items-center text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
                            <label>Learning Rate</label>
                            <span className="font-mono text-cyan-400">{learningRate.toFixed(3)}</span>
                        </div>
                        <input
                            type="range"
                            min="0.001"
                            max="0.5"
                            step="0.001"
                            value={learningRate}
                            onChange={(e) => onLearningRateChange(parseFloat(e.target.value))}
                            className="w-full accent-cyan-500 h-1 bg-muted rounded-full cursor-pointer"
                        />
                    </div>

                    <div className="flex gap-2">
                        <input
                            type="number"
                            step="0.01"
                            value={manualX}
                            onChange={(e) => setManualX(e.target.value)}
                            className="w-1/2 bg-muted/30 border border-border/20 rounded-lg px-2 py-1.5 text-[10px] font-mono text-foreground focus:outline-none focus:border-cyan-500/30"
                            placeholder="X"
                        />
                        <input
                            type="number"
                            step="0.01"
                            value={manualY}
                            onChange={(e) => setManualY(e.target.value)}
                            className="w-1/2 bg-muted/30 border border-border/20 rounded-lg px-2 py-1.5 text-[10px] font-mono text-foreground focus:outline-none focus:border-cyan-500/30"
                            placeholder="Y"
                        />
                        <button
                            onClick={handleManualAdd}
                            className="flex items-center justify-center p-2 rounded-lg bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/20 transition-all"
                        >
                            <Plus size={14} />
                        </button>
                    </div>
                </div>

                {/* Primary Actions */}
                <div className="pt-2 border-t border-border/50 space-y-2">
                    <button
                        onClick={onToggleTraining}
                        className={`w-full flex items-center justify-center gap-2 py-3 rounded-xl font-bold transition-all uppercase tracking-widest text-xs border ${isTraining
                            ? 'bg-rose-500 border-rose-600 text-white'
                            : 'bg-emerald-500 border-emerald-600 text-white'
                            }`}
                    >
                        {isTraining ? <><Square size={14} fill="currentColor" /> Stop Execution</> : <><Play size={14} fill="currentColor" /> Run Trainer</>}
                    </button>

                    <div className="grid grid-cols-2 gap-2">
                        <button
                            onClick={onClearPoints}
                            className="flex items-center justify-center gap-2 py-2 rounded-lg text-[9px] font-bold font-mono bg-muted/40 border border-border/50 hover:bg-muted/80 text-muted-foreground hover:text-foreground transition-all uppercase"
                        >
                            <Trash2 size={12} /> Reset
                        </button>
                        <div className="flex flex-col gap-1">
                            <button
                                onClick={onExportWeights}
                                className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-[9px] font-bold font-mono bg-muted/40 border border-border/50 hover:bg-muted/80 text-cyan-400/60 hover:text-cyan-400 transition-all uppercase"
                            >
                                <Download size={12} /> Export Weights
                            </button>
                            <label className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-[9px] font-bold font-mono bg-muted/40 border border-border/50 hover:bg-muted/80 text-cyan-400/60 hover:text-cyan-400 transition-all cursor-pointer uppercase">
                                <Upload size={12} /> Import Weights
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
                        <div className="flex flex-col gap-1">
                            <button
                                onClick={onExportDataset}
                                className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-[9px] font-bold font-mono bg-muted/40 border border-border/50 hover:bg-muted/80 text-purple-400/60 hover:text-purple-400 transition-all uppercase"
                            >
                                <Database size={12} /> Export Data
                            </button>
                            <label className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-[9px] font-bold font-mono bg-muted/40 border border-border/50 hover:bg-muted/80 text-purple-400/60 hover:text-purple-400 transition-all cursor-pointer uppercase">
                                <Upload size={12} /> Import Data
                                <input
                                    type="file"
                                    accept="application/json"
                                    className="hidden"
                                    onChange={(e) => {
                                        const file = e.target.files?.[0];
                                        if (file) onImportDataset(file);
                                    }}
                                />
                            </label>
                        </div>
                    </div>
                </div>
            </div>

            <div className="p-3 bg-muted/20 border-t border-border text-[7px] text-muted-foreground font-mono text-center tracking-widest uppercase">
                PRIX_PROTOCOL • ML_CORE_WASM
            </div>
        </div>
    );
};
