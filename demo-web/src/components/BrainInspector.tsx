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
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-8">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-4xl max-h-[80vh] flex flex-col overflow-hidden shadow-2xl">
        <div className="p-6 border-b border-zinc-800 flex justify-between items-center">
          <div>
            <h2 className="text-xl font-bold text-white">Brain Inspector</h2>
            <p className="text-sm text-zinc-500">Real-time Neural Activation DAG</p>
          </div>
          <button 
            onClick={onClose}
            className="p-2 hover:bg-zinc-800 rounded-full transition-colors text-zinc-400 hover:text-white"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        
        <div className="flex-1 overflow-auto p-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {nodes.map((node) => (
            <div key={`node-${node.id}`} className="bg-zinc-800/50 border border-white/5 p-4 rounded-xl hover:border-emerald-500/30 transition-all group">
              <div className="flex justify-between items-start mb-2">
                <span className="text-[10px] font-mono text-emerald-500 uppercase tracking-widest">{node.type}</span>
                <span className="text-[10px] font-mono text-zinc-600">ID: {node.id}</span>
              </div>
              <h3 className="text-sm font-semibold text-zinc-200 group-hover:text-emerald-400 transition-colors">{node.name}</h3>
              
              <div className="mt-4 flex flex-wrap gap-1">
                {node.value?.slice(0, 12).map((v, i) => (
                  <div 
                    key={`node-${node.id}-val-${i}`}
                    className="w-3 h-3 rounded-[2px]"
                    style={{ 
                      backgroundColor: `rgba(16, 185, 129, ${Math.min(1, Math.abs(v))})`,
                      boxShadow: v > 0.5 ? '0 0 8px rgba(16, 185, 129, 0.4)' : 'none'
                    }}
                    title={v.toFixed(3)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="p-4 bg-zinc-950/50 border-t border-zinc-800 text-[10px] text-zinc-600 font-mono text-center">
          PROTOCOL: NEURAL_VIS_01 • PRIX_ENGINE
        </div>
      </div>
    </div>
  );
};
