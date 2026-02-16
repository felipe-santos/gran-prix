import React from 'react';

interface LearningLabProps {
  mutationRate: number;
  setMutationRate: (val: number) => void;
  mutationScale: number;
  setMutationScale: (val: number) => void;
}

export const LearningLab: React.FC<LearningLabProps> = ({ 
  mutationRate, 
  setMutationRate, 
  mutationScale, 
  setMutationScale 
}) => {
  return (
    <div className="w-96 flex flex-col bg-card/50 border border-border rounded-2xl overflow-hidden shadow-2xl backdrop-blur-md animate-in slide-in-from-right duration-500 delay-150">
      <div className="p-4 border-b border-border bg-card/80">
        <h2 className="text-sm font-bold text-foreground uppercase tracking-tighter">Learning Lab</h2>
        <p className="text-[10px] text-muted-foreground font-mono">ALGO_PARAMETER_CONTROL</p>
      </div>

      <div className="p-6 space-y-8">
        {/* Mutation Rate */}
        <div className="space-y-4">
          <div className="flex justify-between items-end">
            <div>
              <label className="text-[10px] font-bold text-foreground/70 uppercase tracking-widest">Mutation Rate</label>
              <p className="text-[9px] text-muted-foreground leading-tight">Frequency of structural changes</p>
            </div>
            <span className="text-sm font-mono font-bold text-emerald-500">{(mutationRate * 100).toFixed(0)}%</span>
          </div>
          <input 
            type="range" 
            min="0" 
            max="1" 
            step="0.01" 
            value={mutationRate}
            onChange={(e) => setMutationRate(parseFloat(e.target.value))}
            className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-emerald-500"
          />
        </div>

        {/* Mutation Scale */}
        <div className="space-y-4">
          <div className="flex justify-between items-end">
            <div>
              <label className="text-[10px] font-bold text-foreground/70 uppercase tracking-widest">Mutation Scale</label>
              <p className="text-[9px] text-muted-foreground leading-tight">Intensity of weight variations</p>
            </div>
            <span className="text-sm font-mono font-bold text-emerald-500">{mutationScale.toFixed(2)}</span>
          </div>
          <input 
            type="range" 
            min="0" 
            max="2" 
            step="0.05" 
            value={mutationScale}
            onChange={(e) => setMutationScale(parseFloat(e.target.value))}
            className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-emerald-500"
          />
        </div>

        {/* Algorithm Switcher Placeholder */}
        <div className="pt-4 border-t border-border/50">
          <label className="text-[10px] font-bold text-foreground/70 uppercase tracking-widest block mb-3">Strategy</label>
          <div className="grid grid-cols-2 gap-2">
            <button className="px-3 py-2 bg-emerald-500/10 border border-emerald-500 text-emerald-500 rounded text-[9px] font-bold uppercase tracking-tighter">
              Genetic Algorithm
            </button>
            <button className="px-3 py-2 bg-muted/50 border border-border text-muted-foreground rounded text-[9px] font-bold uppercase tracking-tighter cursor-not-allowed opacity-50">
              Backpropagation
            </button>
          </div>
        </div>
      </div>

      <div className="p-3 bg-muted/50 border-t border-border text-[8px] text-muted-foreground font-mono text-center tracking-widest">
        SYSTEM_UPTIME: LIVE • PRIX_LAB_v1
      </div>
    </div>
  );
};
