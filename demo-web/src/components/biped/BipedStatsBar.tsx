import React from 'react';
import { MAX_FRAMES, POPULATION_SIZE } from './useBipedEvolution';

interface BipedStatsBarProps {
    generation: number;
    frame: number;
    population: number;
    maxFitness: number;
}

const StatItem = ({ label, value, color }: { label: string; value: string | number; color: string }) => (
    <div className="flex flex-col items-center">
        <span className="text-[9px] uppercase tracking-[0.3em] text-muted-foreground font-bold mb-1">
            {label}
        </span>
        <span className={`text-xl font-mono font-medium ${color}`}>{value}</span>
    </div>
);

const Divider = () => <div className="h-8 w-px bg-foreground/[0.05]" />;

export const BipedStatsBar: React.FC<BipedStatsBarProps> = ({ generation, frame, population, maxFitness }) => {
    return (
        <div className="w-full max-w-5xl mb-6 px-10 py-5 bg-foreground/[0.01] rounded-xl border border-foreground/[0.05] flex items-center justify-between">
            <StatItem label="Generation" value={generation} color="text-emerald-500" />
            <Divider />
            <StatItem label="Alive" value={`${population} / ${POPULATION_SIZE}`} color="text-foreground/70" />
            <Divider />
            <StatItem label="Frame" value={`${frame} / ${MAX_FRAMES}`} color="text-foreground/70" />
            <Divider />
            <StatItem label="Max Fitness" value={maxFitness.toFixed(2)} color="text-foreground" />
        </div>
    );
};
