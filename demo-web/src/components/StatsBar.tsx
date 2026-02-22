import React from 'react';
import { GameStats, POPULATION_SIZE } from '../types';

interface StatsBarProps {
    stats: GameStats | null;
}

export const StatsBar: React.FC<StatsBarProps> = ({ stats }) => {
    if (!stats) return null;
    return (
        <div className="w-full max-w-5xl mb-6 px-10 py-5 bg-foreground/[0.01] rounded-xl border border-foreground/[0.05] flex items-center justify-between">
            <StatItem label="Generation" value={stats.generation} color="text-amber-500" />
            <Divider />
            <StatItem label="Population" value={`${stats.alive} / ${POPULATION_SIZE}`} color="text-foreground/70" />
            <Divider />
            <StatItem label="Peak Fitness" value={Math.floor(stats.best)} color="text-foreground/70" />
            <Divider />
            <StatItem label="Real-time Score" value={stats.score} color="text-foreground" />
        </div>
    );
};

const StatItem = ({ label, value, color }: { label: string, value: string | number, color: string }) => (
    <div className="flex flex-col items-center">
        <span className="text-[9px] uppercase tracking-[0.3em] text-muted-foreground font-bold mb-1">{label}</span>
        <span className={`text-xl font-mono font-medium ${color}`}>{value}</span>
    </div>
);

const Divider = () => <div className="h-8 w-px bg-foreground/[0.05]"></div>;
