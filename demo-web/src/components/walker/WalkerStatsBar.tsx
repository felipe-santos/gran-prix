import React from 'react';
import { WalkerStats, WALKER_POPULATION_SIZE } from '../../types';

interface WalkerStatsBarProps {
    stats: WalkerStats | null;
}

/** Stat cell — pure presentational, no logic. */
const StatItem = ({
    label,
    value,
    color,
}: {
    label: string;
    value: string | number;
    color: string;
}) => (
    <div className="flex flex-col items-center">
        <span className="text-[9px] uppercase tracking-[0.3em] text-muted-foreground font-bold mb-1">
            {label}
        </span>
        <span className={`text-xl font-mono font-medium ${color}`}>{value}</span>
    </div>
);

const Divider = () => <div className="h-8 w-px bg-foreground/[0.05]" />;

/**
 * Top stats bar for the Bipedal Walker demo.
 * Mirrors FlappyStatsBar structure — same Feng-Shui rhythm of spacing & alignment.
 */
export const WalkerStatsBar: React.FC<WalkerStatsBarProps> = ({ stats }) => {
    if (!stats) return null;
    return (
        <div className="w-full max-w-5xl mb-6 px-10 py-5 bg-foreground/[0.01] rounded-xl border border-foreground/[0.05] flex items-center justify-between">
            <StatItem
                label="Generation"
                value={stats.generation}
                color="text-emerald-500"
            />
            <Divider />
            <StatItem
                label="Alive"
                value={`${stats.alive} / ${WALKER_POPULATION_SIZE}`}
                color="text-foreground/70"
            />
            <Divider />
            <StatItem
                label="Best Fitness"
                value={Math.floor(stats.best)}
                color="text-foreground/70"
            />
            <Divider />
            <StatItem
                label="Avg Distance"
                value={`${stats.avgDistance}m`}
                color="text-foreground"
            />
        </div>
    );
};
