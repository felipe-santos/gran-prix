import React from 'react';
import { PredatorPreyStats, PREDATOR_POPULATION_SIZE, PREY_POPULATION_SIZE } from '../../types';

interface PredatorPreyStatsBarProps {
    stats: PredatorPreyStats | null;
}

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

export const PredatorPreyStatsBar: React.FC<PredatorPreyStatsBarProps> = ({ stats }) => {
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
                label="Foxes (Alive)"
                value={`${stats.predatorsAlive} / ${PREDATOR_POPULATION_SIZE}`}
                color="text-rose-500"
            />
            <Divider />
            <StatItem
                label="Fox Best Fit"
                value={Math.floor(stats.predatorBest)}
                color="text-foreground/70"
            />
            <Divider />
            <StatItem
                label="Rabbits (Alive)"
                value={`${stats.preyAlive} / ${PREY_POPULATION_SIZE}`}
                color="text-blue-400"
            />
            <Divider />
            <StatItem
                label="Rabbit Best Fit"
                value={Math.floor(stats.preyBest)}
                color="text-foreground/70"
            />
        </div>
    );
};
