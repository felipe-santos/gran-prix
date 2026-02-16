import React from 'react';
import * as wasm from '../wasm/pkg/gran_prix_wasm';

interface LearningLabProps {
  mutationRate: number;
  setMutationRate: (val: number) => void;
  mutationScale: number;
  setMutationScale: (val: number) => void;
  mutationStrategy: wasm.MutationStrategy;
  setMutationStrategy: (val: wasm.MutationStrategy) => void;
  customKernel: [number, number, number];
  setCustomKernel: (kernel: [number, number, number]) => void;
}

export const LearningLab: React.FC<LearningLabProps> = ({ 
  mutationRate, 
  setMutationRate, 
  mutationScale, 
  setMutationScale,
  mutationStrategy,
  setMutationStrategy,
  customKernel,
  setCustomKernel
}) => {
  const getFormula = () => {
    switch (mutationStrategy) {
      case wasm.MutationStrategy.Additive: 
        return "w_next = w + random(-s, s)";
      case wasm.MutationStrategy.Multiplicative: 
        return "w_next = w * (1 + random(-s, s))";
      case wasm.MutationStrategy.Reset: 
        return "w_next = random(-s, s)";
      default: return "";
    }
  };

  const getDescription = () => {
    switch (mutationStrategy) {
      case wasm.MutationStrategy.Additive: 
        return "Refinamento local. Mantém a base do conhecimento.";
      case wasm.MutationStrategy.Multiplicative: 
        return "Ajuste proporcional. Mudança escalar agressiva.";
      case wasm.MutationStrategy.Reset: 
        return "Reinicio total. Explora novas áreas de solução.";
      default: return "";
    }
  };

  const handleKernelChange = (index: number, value: string) => {
    const val = parseFloat(value) || 0;
    const newKernel = [...customKernel] as [number, number, number];
    newKernel[index] = val;
    setCustomKernel(newKernel);
  };

  return (
    <div className="w-96 flex flex-col bg-card/50 border border-border rounded-2xl overflow-hidden backdrop-blur-md animate-in slide-in-from-right duration-500 delay-150">
      <div className="p-4 border-b border-border bg-card/80">
        <h2 className="text-sm font-bold text-foreground uppercase tracking-tighter">Learning Lab</h2>
        <p className="text-[10px] text-muted-foreground font-mono">NEURAL_CALCULUS_MODIFIER</p>
      </div>

      <div className="p-6 space-y-8 max-h-[70vh] overflow-y-auto">
        {/* Neural Architect - Custom Kernel */}
        <div className="space-y-4">
          <label className="text-[10px] font-bold text-foreground/70 uppercase tracking-widest block">Neural Architect (Convolução 1D)</label>
          <p className="text-[9px] text-muted-foreground leading-tight">Define como os sensores processam o ambiente antes de pensar.</p>
          
          <div className="flex gap-2 justify-between">
            {customKernel.map((val, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-1">
                <input 
                  type="number" 
                  step="0.1"
                  value={val}
                  onChange={(e) => handleKernelChange(i, e.target.value)}
                  className="w-full bg-muted/50 border border-border/50 rounded-lg p-2 text-center text-xs font-mono font-bold text-emerald-500 focus:outline-none focus:border-emerald-500/50"
                />
                <span className="text-[8px] text-muted-foreground font-mono uppercase tracking-tighter">k{i+1}</span>
              </div>
            ))}
          </div>

          <div className="bg-emerald-500/5 border border-emerald-500/10 p-3 rounded-lg">
             <p className="text-[10px] font-mono text-emerald-500/80 mb-1">
               S'_i = S_i-1*{customKernel[0].toFixed(1)} + S_i*{customKernel[1].toFixed(1)} + S_i+1*{customKernel[2].toFixed(1)}
             </p>
             <p className="text-[9px] text-muted-foreground italic font-medium">Filtro de pré-processamento sensorial manual.</p>
          </div>
        </div>

        {/* Mutation Strategy */}
        <div className="space-y-4">
          <label className="text-[10px] font-bold text-foreground/70 uppercase tracking-widest block">Lógica de Mutação</label>
          <div className="flex flex-col gap-2">
            {[
              { id: wasm.MutationStrategy.Additive, label: "Aditivo" },
              { id: wasm.MutationStrategy.Multiplicative, label: "Multiplicativo" },
              { id: wasm.MutationStrategy.Reset, label: "Reset" }
            ].map((strat) => (
              <button
                key={strat.id}
                onClick={() => setMutationStrategy(strat.id)}
                className={`px-3 py-2 text-[10px] font-bold uppercase tracking-tight rounded-lg border transition-all text-left flex justify-between items-center ${
                  mutationStrategy === strat.id 
                    ? 'bg-emerald-500/10 border-emerald-500 text-emerald-500' 
                    : 'bg-muted/30 border-border/50 text-muted-foreground hover:border-border'
                }`}
              >
                {strat.label}
                {mutationStrategy === strat.id && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"></span>}
              </button>
            ))}
          </div>
          <div className="bg-emerald-500/5 border border-emerald-500/10 p-3 rounded-lg">
             <p className="text-[10px] font-mono text-emerald-500/80 mb-1">{getFormula()}</p>
             <p className="text-[9px] text-muted-foreground italic font-medium">{getDescription()}</p>
          </div>
        </div>

        {/* Mutation Rate */}
        <div className="space-y-4">
          <div className="flex justify-between items-end">
            <div>
              <label className="text-[10px] font-bold text-foreground/70 uppercase tracking-widest">Mutation Rate</label>
              <p className="text-[9px] text-muted-foreground leading-tight">Probabilidade de alteração</p>
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
              <label className="text-[10px] font-bold text-foreground/70 uppercase tracking-widest">Mutation Scale (s)</label>
              <p className="text-[9px] text-muted-foreground leading-tight">Intensidade do ruído</p>
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
      </div>

      <div className="p-3 bg-muted/50 border-t border-border text-[8px] text-muted-foreground font-mono text-center tracking-widest">
        STRATEGY_PRIX_v2 • CALCULUS_ACTIVE
      </div>
    </div>
  );
};
