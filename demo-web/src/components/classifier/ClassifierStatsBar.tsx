import React from 'react';

interface ClassifierStats {
    generation: number;
    loss: number;
    lr: number;
}

const Stat: React.FC<{ label: string; value: string | number; icon?: string; colorClass?: string }> = ({ label, value, icon, colorClass = "text-foreground" }) => (
    <div className="flex flex-col items-center justify-center bg-black/20 px-3 py-1.5 rounded-lg border border-white/5 min-w-[100px]">
        <span className="text-[9px] uppercase font-bold tracking-widest text-muted-foreground mb-0.5">
            {label}
        </span>
        <div className="flex items-center gap-1.5">
            {icon && <span className="text-sm">{icon}</span>}
            <span className={`text-sm font-mono font-black ${colorClass}`}>{value}</span>
        </div>
    </div>
);

export const ClassifierStatsBar: React.FC<{ stats: ClassifierStats }> = ({ stats }) => {
    return (
        <div className="flex flex-wrap items-center justify-center gap-2 mb-4 w-full max-w-2xl">
            <div className="grid grid-cols-3 gap-2 w-full">
                <Stat label="Epoch" value={stats.generation} colorClass="text-cyan-400" />
                <Stat label="Loss" value={stats.loss.toFixed(6)} colorClass="text-emerald-400" />
                <Stat label="Rate" value={stats.lr.toFixed(3)} colorClass="text-amber-400" />
            </div>
        </div>
    );
};
