import React from 'react';
import { VacuumStats, VACUUM_MAX_FRAMES } from '../../types';

interface VacuumStatsBarProps {
    stats: VacuumStats | null;
    battery: number;
    dustProgress: number;
    frame: number;
}

export const VacuumStatsBar: React.FC<VacuumStatsBarProps> = ({
    stats,
    battery,
    dustProgress,
    frame,
}) => {
    if (!stats) return null;
    return (
        <div className="w-full flex flex-wrap items-center justify-center gap-6 mb-4 px-4">
            <Stat label="Generation" value={`${stats.generation}`} />
            <Stat label="Best Fitness" value={stats.best.toFixed(2)} accent />
            <Stat label="Dust Cleaned" value={`${(dustProgress * 100).toFixed(0)}%`} icon="🧹" />
            <Stat label="Battery" value={`${(battery * 100).toFixed(0)}%`} icon={battery > 0.3 ? '🔋' : '🪫'} />
            <Stat label="Avg Cleaned" value={`${stats.avgCleaned.toFixed(0)}`} />
            <Stat label="Alive" value={`${stats.alive}`} />
            <Stat label="Frame" value={`${frame}/${VACUUM_MAX_FRAMES}`} />
        </div>
    );
};

function Stat({ label, value, accent, icon }: { label: string; value: string; accent?: boolean; icon?: string }) {
    return (
        <div className="flex flex-col items-center">
            <span className="text-[8px] text-muted-foreground uppercase tracking-widest font-bold">{label}</span>
            <span className={`text-sm font-mono font-bold ${accent ? 'text-emerald-500' : 'text-foreground'}`}>
                {icon && <span className="mr-1">{icon}</span>}
                {value}
            </span>
        </div>
    );
}
