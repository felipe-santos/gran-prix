import React, { useRef } from 'react';
import { Download, Upload, Code, BrainCircuit } from 'lucide-react';

interface BrainPersistenceProps {
    weights: Float32Array | null;
    hiddenLayers: number[];
    inputDim: number;
    onImport: (weights: Float32Array) => void;
    onExportCCode?: () => void;
    title?: string;
    subtitle?: string;
}

export const BrainPersistence: React.FC<BrainPersistenceProps> = ({
    weights,
    hiddenLayers,
    inputDim,
    onImport,
    onExportCCode,
    title = "Neural Core",
    subtitle = "Weight Persistence & Export",
}) => {
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleExportJSON = () => {
        if (!weights) return;
        const blob = new Blob([JSON.stringify(Array.from(weights))], { type: 'application/json' });
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
        if (!file) return;

        try {
            const text = await file.text();
            const arr = JSON.parse(text);
            if (!Array.isArray(arr)) throw new Error("Invalid format");
            onImport(new Float32Array(arr));
        } catch (err) {
            console.error("Import failed:", err);
            alert("Failed to import weights JSON file.");
        }

        // Reset input
        e.target.value = '';
    };

    return (
        <div className="bg-card/50 border border-border rounded-2xl overflow-hidden backdrop-blur-md flex flex-col shadow-xl">
            <div className="p-4 border-b border-border bg-card/80 flex items-center justify-between">
                <div className="flex flex-col">
                    <h3 className="text-sm font-bold text-foreground uppercase tracking-tighter flex items-center gap-2">
                        <BrainCircuit size={14} className="text-emerald-500" /> {title}
                    </h3>
                    <p className="text-[9px] text-muted-foreground font-mono mt-0.5 uppercase">{subtitle}</p>
                </div>
                {weights && (
                    <div className="flex gap-2">
                        <div className="px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-[8px] font-black text-blue-500 uppercase tracking-widest leading-none flex items-center">
                            {inputDim} + {hiddenLayers.join('+')} + 1
                        </div>
                        <div className="px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-[8px] font-black text-emerald-500 uppercase tracking-widest leading-none flex items-center">
                            {weights.length} Params
                        </div>
                    </div>
                )}
            </div>

            <div className="p-4 grid grid-cols-1 gap-2">
                <button
                    onClick={handleExportJSON}
                    disabled={!weights}
                    className="flex items-center justify-between px-3 py-2 bg-muted/40 hover:bg-muted/60 disabled:opacity-30 disabled:hover:bg-muted/40 rounded-lg border border-border/50 transition-all group"
                >
                    <div className="flex items-center gap-2">
                        <Download size={14} className="text-blue-400 group-hover:scale-110 transition-transform" />
                        <span className="text-[10px] font-bold uppercase tracking-wider">Export Weights</span>
                    </div>
                    <span className="text-[8px] font-mono text-muted-foreground">.JSON</span>
                </button>

                <button
                    onClick={handleImportClick}
                    className="flex items-center justify-between px-3 py-2 bg-muted/40 hover:bg-muted/60 rounded-lg border border-border/50 transition-all group"
                >
                    <div className="flex items-center gap-2">
                        <Upload size={14} className="text-amber-400 group-hover:scale-110 transition-transform" />
                        <span className="text-[10px] font-bold uppercase tracking-wider">Import Weights</span>
                    </div>
                    <span className="text-[8px] font-mono text-muted-foreground">.JSON</span>
                </button>

                {onExportCCode && (
                    <button
                        onClick={onExportCCode}
                        disabled={!weights}
                        className="flex items-center justify-between px-3 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 disabled:opacity-30 disabled:hover:bg-emerald-500/10 rounded-lg border border-emerald-500/20 transition-all group"
                    >
                        <div className="flex items-center gap-2">
                            <Code size={14} className="text-emerald-500 group-hover:scale-110 transition-transform" />
                            <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-500">Generate C Code</span>
                        </div>
                        <span className="text-[8px] font-mono text-emerald-500/60">.H</span>
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

            <div className="p-3 bg-muted/20 border-t border-border text-[7px] text-muted-foreground font-mono text-center tracking-widest uppercase">
                Hardware Abstraction Layer
            </div>
        </div>
    );
};
