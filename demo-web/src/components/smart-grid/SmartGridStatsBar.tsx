import React from 'react';
import { GridStats } from '../../types';

interface SmartGridStatsBarProps {
    stats: GridStats;
    solarOutput: number;
    batterySoC: number;
    gridPrice: number;
    hour: number;
}

export const SmartGridStatsBar: React.FC<SmartGridStatsBarProps> = ({
    stats,
    solarOutput,
    batterySoC,
    gridPrice,
    hour,
}) => {
    const hourStr = `${Math.floor(hour).toString().padStart(2, '0')}:${(Math.floor((hour % 1) * 60)).toString().padStart(2, '0')}`;
    const isNight = hour < 6 || hour > 20;

    return (
        <div className="w-full flex flex-wrap items-center justify-center gap-6 mb-4 px-4">
            <Stat label="Generation" value={`${stats.generation}`} />
            <Stat label="Best Fitness" value={stats.best.toFixed(2)} accent />
            <Stat label="Avg Cost" value={`$${stats.avgCost.toFixed(2)}`} />
            <Stat label="Time" value={hourStr} icon={isNight ? '🌙' : '☀️'} />
            <Stat label="Solar" value={`${solarOutput.toFixed(1)} kW`} />
            <Stat label="Battery" value={`${(batterySoC * 100).toFixed(0)}%`} />
            <Stat label="Price" value={`$${gridPrice.toFixed(2)}/kWh`} />
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
