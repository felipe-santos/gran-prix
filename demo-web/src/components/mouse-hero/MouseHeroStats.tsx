import React from 'react';
import { MousePredictionPhase } from '../../types';
import { Target, Activity, Cpu } from 'lucide-react';

interface MouseHeroStatsProps {
    phase: MousePredictionPhase;
    samples: number;
    lossX: number;
    lossY: number;
}

export const MouseHeroStats: React.FC<MouseHeroStatsProps> = ({
    phase,
    samples,
    lossX,
    lossY,
}) => {
    return (
        <div className="absolute top-8 right-8 z-10 flex flex-col items-end gap-3 pointer-events-none">
            {/* Phase Badge */}
            <div className={`relative flex items-center gap-3 px-4 py-2 rounded-xl border backdrop-blur-xl transition-all duration-1000 shadow-2xl ${phase === 'training'
                    ? 'bg-amber-500/5 border-amber-500/20 text-amber-500 shadow-amber-500/10'
                    : 'bg-[#00e5ff]/5 border-[#00e5ff]/30 text-[#00e5ff] shadow-[#00e5ff]/20'
                }`}>
                {phase === 'training' ? <Activity size={14} className="animate-pulse" /> : <Target size={14} />}
                <span className="text-[10px] font-black uppercase tracking-[0.3em]">
                    {phase === 'training' ? 'Data Collection' : 'Live Inference'}
                </span>
                {phase === 'predicting' && (
                    <span className="absolute -inset-0 border border-[#00e5ff] rounded-xl animate-ping opacity-20" />
                )}
            </div>

            {/* Cyberpunk HUD Stats Panel */}
            <div className="flex flex-col gap-2 p-4 bg-background/40 backdrop-blur-xl rounded-xl border border-white/10 shadow-2xl min-w-[200px]">

                <div className="flex items-center justify-between border-b border-white/5 pb-2 mb-1">
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                        <Cpu size={12} />
                        <span className="text-[8px] font-bold uppercase tracking-widest">WASM Neural Core</span>
                    </div>
                </div>

                <div className="flex justify-between items-end group">
                    <span className="text-[9px] font-medium tracking-widest text-muted-foreground">SAMPLES</span>
                    <span className="font-mono text-sm font-bold text-emerald-400 drop-shadow-[0_0_8px_rgba(16,185,129,0.5)] transition-all">
                        {samples.toString().padStart(4, '0')}
                    </span>
                </div>

                <div className="flex justify-between items-end mt-1">
                    <span className="text-[9px] font-medium tracking-widest text-muted-foreground">BCE LOSS X</span>
                    <span className="font-mono text-xs text-foreground/80">
                        {lossX.toFixed(5)}
                    </span>
                </div>

                <div className="flex justify-between items-end">
                    <span className="text-[9px] font-medium tracking-widest text-muted-foreground">BCE LOSS Y</span>
                    <span className="font-mono text-xs text-foreground/80">
                        {lossY.toFixed(5)}
                    </span>
                </div>

                {/* Simulated Data Stream Visualization */}
                <div className="h-1.5 w-full bg-white/5 rounded-full mt-2 overflow-hidden flex">
                    <div
                        className={`h-full transition-all duration-300 ${phase === 'training' ? 'bg-amber-500' : 'bg-[#00e5ff]'}`}
                        style={{ width: `${Math.min(100, samples / 5)}%` }}
                    />
                </div>
            </div>
        </div>
    );
};
