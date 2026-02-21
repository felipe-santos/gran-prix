import React from 'react';
import { OvenStats, OvenFoodType, OVEN_MAX_FRAMES } from '../../types';

interface OvenStatsBarProps {
    stats: OvenStats;
    frame: number;
    currentFood: OvenFoodType;
    bestAir: number;
    bestSurface: number;
}

const Stat: React.FC<{ label: string; value: string | number; icon?: string }> = ({ label, value, icon }) => (
    <div className="flex flex-col items-center justify-center bg-black/20 px-3 py-1.5 rounded-lg border border-white/5 min-w-[70px]">
        <span className="text-[9px] uppercase font-bold tracking-widest text-muted-foreground mb-0.5">
            {label}
        </span>
        <div className="flex items-center gap-1.5">
            {icon && <span className="text-sm">{icon}</span>}
            <span className="text-sm font-mono font-black text-foreground">{value}</span>
        </div>
    </div>
);

export const OvenStatsBar: React.FC<OvenStatsBarProps> = ({ stats, frame, currentFood, bestAir, bestSurface }) => {
    const getFoodIcon = (food: OvenFoodType) => {
        switch (food) {
            case OvenFoodType.Cake: return '🎂';
            case OvenFoodType.Bread: return '🥖';
            case OvenFoodType.Turkey: return '🦃';
            case OvenFoodType.Pizza: return '🍕';
            default: return '🥘';
        }
    };

    return (
        <div className="flex flex-wrap items-center justify-center gap-2 mb-4 w-full">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2 w-full">
                <Stat label="Gen" value={stats.generation} />
                <Stat label="Food" value={currentFood} icon={getFoodIcon(currentFood)} />
                <Stat label="Best Fitness" value={stats.bestFitness.toFixed(0)} />
                <Stat label="Avg Fitness" value={stats.avgFitness.toFixed(0)} />
                <Stat label="Air" value={`${bestAir.toFixed(1)}°C`} icon="🌡️" />
                <Stat label="Surface" value={`${bestSurface.toFixed(1)}°C`} />
                <Stat label="Core" value={`${stats.bestCoreTemp.toFixed(1)}°C`} />
                <Stat label="Frame" value={`${frame}/${OVEN_MAX_FRAMES}`} />
            </div>
            {/* Success Rates Row */}
            <div className="flex w-full gap-2 items-center justify-center mt-2 px-2">
                <span className="text-[9px] uppercase font-bold tracking-widest text-muted-foreground mr-2">Success Rates:</span>
                {Object.values(OvenFoodType).map(type => (
                    <div key={type} className="flex items-center gap-1 bg-black/20 px-2 py-1 rounded border border-white/5">
                        <span className="text-xs">{getFoodIcon(type)}</span>
                        <span className="text-[10px] font-mono font-bold text-emerald-400">
                            {(stats.successRates?.[type] || 0).toFixed(0)}%
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
};
