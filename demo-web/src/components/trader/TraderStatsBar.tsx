import { TraderStats } from '../../types';

interface TraderStatsBarProps {
    stats: TraderStats | null;
    currentPrice: number;
    rsi: number;
    tick: number;
}

export const TraderStatsBar = ({
    stats,
    currentPrice,
    rsi,
    tick,
}: TraderStatsBarProps) => {
    if (!stats) return null;
    const roiColor = stats.bestROI >= 1 ? 'text-emerald-500' : 'text-red-400';
    const rsiColor = rsi > 70 ? 'text-red-400' : rsi < 30 ? 'text-emerald-500' : 'text-foreground';

    return (
        <div className="w-full flex flex-wrap items-center justify-center gap-6 mb-4 px-4">
            <Stat label="Generation" value={`${stats.generation}`} />
            <Stat label="Best ROI" value={`${((stats.bestROI - 1) * 100).toFixed(1)}%`} className={roiColor} />
            <Stat label="Avg ROI" value={`${((stats.avgROI - 1) * 100).toFixed(1)}%`} />
            <Stat label="Drawdown" value={`${(stats.bestDrawdown * 100).toFixed(1)}%`} className="text-amber-400" />
            <Stat label="Price" value={`$${currentPrice.toFixed(2)}`} />
            <Stat label="RSI" value={rsi.toFixed(0)} className={rsiColor} />
            <Stat label="Candle" value={`${tick}/500`} />
            <Stat label="Alive" value={`${stats.alive}`} />
        </div>
    );
};

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
    return (
        <div className="flex flex-col items-center">
            <span className="text-[8px] text-muted-foreground uppercase tracking-widest font-bold">{label}</span>
            <span className={`text-sm font-mono font-bold ${className || 'text-foreground'}`}>
                {value}
            </span>
        </div>
    );
}
