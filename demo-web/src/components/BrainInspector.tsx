import React from 'react';

interface Node {
  id: number;
  type: string;
  name: string;
  value?: number[];
}

interface BrainInspectorProps {
  nodes: Node[];
  onClose: () => void;
}

export const BrainInspector: React.FC<BrainInspectorProps> = ({ nodes, onClose }) => {
  return (
    <div className="w-96 h-[600px] bg-card/50 border border-border rounded-2xl flex flex-col overflow-hidden backdrop-blur-md animate-in slide-in-from-right duration-300">
      <div className="p-4 border-b border-border flex justify-between items-center bg-card/80">
        <div>
          <h2 className="text-sm font-bold text-foreground uppercase tracking-tighter">Brain Inspector</h2>
          <p className="text-[10px] text-muted-foreground font-mono">NEURAL_STREAM_ACTIVE</p>
        </div>
        <button 
          onClick={onClose}
          className="p-1 hover:bg-muted rounded-full transition-colors text-muted-foreground hover:text-foreground"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      
      <div className="flex-1 overflow-auto p-4 space-y-3 custom-scrollbar">
        {nodes.map((node) => (
          <div key={`node-${node.id}`} className="bg-muted/30 border border-border/50 p-3 rounded-lg hover:border-emerald-500/30 transition-all group">
            <div className="flex justify-between items-center mb-1">
              <span className="text-[9px] font-mono text-emerald-600 dark:text-emerald-400 py-0.5 px-1.5 bg-emerald-500/10 rounded uppercase leading-none">{node.type}</span>
              <span className="text-[9px] font-mono text-muted-foreground">#{node.id}</span>
            </div>
            <h3 className="text-xs font-medium text-foreground group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors truncate">{node.name}</h3>
            
            <div className="mt-3 flex flex-wrap gap-1">
              {node.value?.slice(0, 12).map((v, i) => (
                <div 
                  key={`node-${node.id}-val-${i}`}
                  className="w-2.5 h-2.5 rounded-[1px]"
                  style={{ 
                    backgroundColor: `rgba(16, 185, 129, ${Math.min(1, Math.abs(v))})`,
                    boxShadow: v > 0.5 ? '0 0 6px rgba(16, 185, 129, 0.3)' : 'none'
                  }}
                  title={v.toFixed(3)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="p-3 bg-muted/50 border-t border-border text-[8px] text-muted-foreground font-mono text-center tracking-widest">
        PRIX_ENGINE • VIS_PROTO_01
      </div>
    </div>
  );
};
