import React from 'react';

interface ClassifierControlsProps {
    pattern: string;
    onPatternChange: (p: any) => void;
    lr: number;
    onLrChange: (v: number) => void;
    hiddenSize: number;
    onHiddenSizeChange: (v: number) => void;
}

export const ClassifierControls: React.FC<ClassifierControlsProps> = ({
    pattern, onPatternChange, lr, onLrChange, hiddenSize, onHiddenSizeChange
}) => {
    return (
        <div className="bg-card/50 border border-border rounded-2xl overflow-hidden backdrop-blur-md">
            <div className="p-4 border-b border-border bg-card/80">
                <h3 className="text-sm font-bold text-foreground uppercase tracking-tighter">
                    Training Configuration
                </h3>
                <p className="text-[9px] text-muted-foreground font-mono mt-0.5">
                    BP_LAB_PROTOCOL
                </p>
            </div>
            
            <div className="p-5 space-y-5">
                {/* Pattern Strategy */}
                <div className="space-y-2">
                    <label className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground block">
                        Dataset Pattern
                    </label>
                    <div className="grid grid-cols-2 gap-2 mt-2">
                        {(['xor', 'circle', 'spiral', 'custom'] as const).map(p => (
                            <button
                                key={p}
                                onClick={() => onPatternChange(p)}
                                className={`px-2 py-1.5 rounded-lg text-[9px] border transition-all ${
                                    pattern === p 
                                    ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-400 font-black' 
                                    : 'bg-white/5 border-white/10 hover:bg-white/10 text-muted-foreground'
                                } uppercase tracking-widest`}
                            >
                                {p}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="h-px bg-border/20" />

                {/* Hyperparameters Section */}
                <div className="space-y-4">
                    <label className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground block">
                        Hyperparameters
                    </label>
                    
                    <div className="space-y-2">
                        <div className="flex justify-between items-center">
                            <span className="text-[9px] font-black uppercase text-muted-foreground tracking-widest">Rate</span>
                            <span className="text-xs font-mono font-bold text-amber-500">{lr.toFixed(3)}</span>
                        </div>
                        <input 
                            type="range" min="0.001" max="0.5" step="0.001" 
                            value={lr} onChange={(e) => onLrChange(parseFloat(e.target.value))}
                            className="accent-amber-500 w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer"
                        />
                    </div>

                    <div className="space-y-2">
                         <div className="flex justify-between items-center">
                            <span className="text-[9px] font-black uppercase text-muted-foreground tracking-widest">Nodes</span>
                            <span className="text-xs font-mono font-bold text-cyan-400">{hiddenSize}</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <button 
                                onClick={() => onHiddenSizeChange(Math.max(2, hiddenSize - 2))}
                                className="flex-1 bg-white/5 border border-white/10 rounded-lg py-1 hover:bg-white/10 text-xs transition-all"
                            >-</button>
                            <button 
                                onClick={() => onHiddenSizeChange(Math.min(32, hiddenSize + 2))}
                                className="flex-1 bg-white/5 border border-white/10 rounded-lg py-1 hover:bg-white/10 text-xs transition-all"
                            >+</button>
                        </div>
                    </div>
                </div>

                {/* Reward info style text */}
                <div className="space-y-2 pt-2 border-t border-border">
                    <label className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground block">
                        Network Logic
                    </label>
                    <div className="space-y-1.5">
                        <div className="flex items-center gap-2">
                            <span className="text-[8px] font-mono font-bold text-emerald-400 w-10 text-right">RMS</span>
                            <span className="text-[8px] text-muted-foreground">Loss calculated via Square Error</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="text-[8px] font-mono font-bold text-emerald-400 w-10 text-right">BP</span>
                            <span className="text-[8px] text-muted-foreground">Partial derivatives via Chain Rule</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="text-[8px] font-mono font-bold text-amber-500 w-10 text-right">LR</span>
                            <span className="text-[8px] text-muted-foreground">Adjusts step size along gradient</span>
                        </div>
                    </div>
                </div>
            </div>

            <div className="p-3 bg-muted/50 border-t border-border text-[8px] text-muted-foreground font-mono text-center tracking-widest">
                BP_LAB_PROTOCOL • NEURAL_CORE
            </div>
        </div>
    );
};
