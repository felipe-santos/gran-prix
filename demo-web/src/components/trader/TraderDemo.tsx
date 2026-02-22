import { useEffect, useRef, useState, useCallback } from 'react';

import {
    TRADER_WIDTH,
    TRADER_HEIGHT,
    Candle,
    TraderStats,
} from '../../types';
import { PerformanceCharts } from '../PerformanceCharts';
import { useSimulation } from '../../hooks/useSimulation';
import { traderSimulationConfig, TraderSimulationState, TraderAgent } from '../../demos/trader/traderSimulation';

import { TraderCanvas } from './TraderCanvas';
import { TraderStatsBar } from './TraderStatsBar';
import { TraderNetworkViz } from './TraderNetworkViz';
import { GameControls } from '../GameControls';

// ─── Candlestick Chart Drawing ───────────────────────────────────────────────

const CHART_LEFT = 60;
const CHART_TOP = 30;
const CHART_WIDTH = TRADER_WIDTH - 90;
const CHART_HEIGHT = TRADER_HEIGHT * 0.55;
const INDICATOR_TOP = CHART_TOP + CHART_HEIGHT + 15;
const INDICATOR_HEIGHT = 60;
const EQUITY_TOP = INDICATOR_TOP + INDICATOR_HEIGHT + 15;
const EQUITY_HEIGHT = TRADER_HEIGHT - EQUITY_TOP - 20;

function drawBackground(ctx: CanvasRenderingContext2D) {
    // Dark trading terminal background
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, TRADER_WIDTH, TRADER_HEIGHT);

    // Subtle grid
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    for (let x = CHART_LEFT; x < CHART_LEFT + CHART_WIDTH; x += 60) {
        ctx.beginPath();
        ctx.moveTo(x, CHART_TOP);
        ctx.lineTo(x, TRADER_HEIGHT);
        ctx.stroke();
    }
}

function drawCandlestickChart(
    ctx: CanvasRenderingContext2D,
    candles: Candle[],
    currentTick: number,
    bestTrades: { tick: number; action: 'buy' | 'sell'; price: number }[],
) {
    const visibleCount = 80;
    const startTick = Math.max(0, currentTick - visibleCount);
    const endTick = Math.min(candles.length, currentTick + 1);
    const visibleCandles = candles.slice(startTick, endTick);

    if (visibleCandles.length === 0) return;

    let minPrice = Infinity, maxPrice = -Infinity;
    for (const c of visibleCandles) {
        if (c.low < minPrice) minPrice = c.low;
        if (c.high > maxPrice) maxPrice = c.high;
    }
    const priceRange = maxPrice - minPrice || 1;
    const padding = priceRange * 0.1;
    minPrice -= padding;
    maxPrice += padding;

    const priceToPx = (p: number) => CHART_TOP + CHART_HEIGHT - ((p - minPrice) / (maxPrice - minPrice)) * CHART_HEIGHT;

    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    const priceSteps = 5;
    for (let i = 0; i <= priceSteps; i++) {
        const price = minPrice + (i / priceSteps) * (maxPrice - minPrice);
        const y = priceToPx(price);
        ctx.fillText(`$${price.toFixed(2)}`, CHART_LEFT - 5, y + 3);

        ctx.strokeStyle = 'rgba(255,255,255,0.04)';
        ctx.beginPath();
        ctx.moveTo(CHART_LEFT, y);
        ctx.lineTo(CHART_LEFT + CHART_WIDTH, y);
        ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.strokeRect(CHART_LEFT, CHART_TOP, CHART_WIDTH, CHART_HEIGHT);

    const candleWidth = (CHART_WIDTH / visibleCount) * 0.8;
    const spacing = CHART_WIDTH / visibleCount;

    visibleCandles.forEach((candle, i) => {
        const x = CHART_LEFT + i * spacing + spacing / 2;
        const color = candle.close >= candle.open ? '#22c55e' : '#ef4444';
        
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(x, priceToPx(candle.low));
        ctx.lineTo(x, priceToPx(candle.high));
        ctx.stroke();

        ctx.fillStyle = color;
        const yOpen = priceToPx(candle.open);
        const yClose = priceToPx(candle.close);
        ctx.fillRect(x - candleWidth / 2, Math.min(yOpen, yClose), candleWidth, Math.max(1, Math.abs(yClose - yOpen)));
    });

    bestTrades.forEach(trade => {
        if (trade.tick >= startTick && trade.tick < endTick) {
            const x = CHART_LEFT + (trade.tick - startTick) * spacing + spacing / 2;
            const y = priceToPx(trade.price);
            
            ctx.beginPath();
            if (trade.action === 'buy') {
                ctx.moveTo(x, y + 15);
                ctx.lineTo(x - 5, y + 25);
                ctx.lineTo(x + 5, y + 25);
                ctx.fillStyle = '#22c55e';
            } else {
                ctx.moveTo(x, y - 15);
                ctx.lineTo(x - 5, y - 25);
                ctx.lineTo(x + 5, y - 25);
                ctx.fillStyle = '#ef4444';
            }
            ctx.fill();
        }
    });
}

function drawIndicators(ctx: CanvasRenderingContext2D, rsi: number, smaCrossover: number) {
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.strokeRect(CHART_LEFT, INDICATOR_TOP, CHART_WIDTH, INDICATOR_HEIGHT);

    ctx.fillStyle = 'white';
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('RSI (7)', CHART_LEFT + 5, INDICATOR_TOP + 12);
    
    ctx.fillStyle = rsi > 70 ? '#ef4444' : rsi < 30 ? '#22c55e' : '#3b82f6';
    const rsiX = CHART_LEFT + 50 + (rsi / 100) * (CHART_WIDTH - 60);
    ctx.fillRect(CHART_LEFT + 50, INDICATOR_TOP + 5, CHART_WIDTH - 60, 8);
    ctx.fillStyle = 'white';
    ctx.fillRect(rsiX - 1, INDICATOR_TOP + 3, 2, 12);

    ctx.fillStyle = 'white';
    ctx.fillText('SMA CROSS', CHART_LEFT + 5, INDICATOR_TOP + 32);
    const scoreColor = smaCrossover > 0 ? '#22c55e' : '#ef4444';
    ctx.fillStyle = scoreColor;
    const crossWidth = Math.min(100, Math.abs(smaCrossover * 5000));
    ctx.fillRect(CHART_LEFT + 50, INDICATOR_TOP + 25, crossWidth, 8);
}

function drawEquityCurve(ctx: CanvasRenderingContext2D, agents: TraderAgent[]) {
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.strokeRect(CHART_LEFT, EQUITY_TOP, CHART_WIDTH, EQUITY_HEIGHT);

    ctx.fillStyle = 'white';
    ctx.font = '8px monospace';
    ctx.fillText('EQUITY DIST.', CHART_LEFT + 5, EQUITY_TOP + 12);

    const maxCapital = Math.max(...agents.map(a => a.capital), 2000);
    
    agents.forEach((agent, i) => {
        const x = CHART_LEFT + (i / agents.length) * CHART_WIDTH;
        const h = (agent.capital / maxCapital) * (EQUITY_HEIGHT - 20);
        ctx.fillStyle = agent.dead ? '#333' : agent.color;
        ctx.fillRect(x, EQUITY_TOP + EQUITY_HEIGHT - h - 5, CHART_WIDTH / agents.length, h);
    });
}

export const TraderDemo: React.FC = () => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rafRef = useRef<number | null>(null);
    const isLoopActive = useRef(false);

    const [isPlaying, setIsPlaying] = useState(false);
    
    const { internalState, stats, performanceHistory, isReady, update, reset, engine } = useSimulation<TraderAgent, TraderSimulationState, TraderStats>(traderSimulationConfig);

    const handleReset = useCallback(() => {
        setIsPlaying(false);
        reset();
    }, [reset]);

    const render = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const state = internalState.current;
        if (!state) return;

        drawBackground(ctx);
        drawCandlestickChart(ctx, state.env.candles, state.frame, state.bestTrades);
        drawIndicators(ctx, state.env.rsi, state.env.smaCrossover);
        drawEquityCurve(ctx, state.agents);
    }, [internalState]);

    const gameLoop = useCallback(() => {
        if (!isPlaying || !isReady) {
            isLoopActive.current = false;
            return;
        }
        update();
        render();
        rafRef.current = requestAnimationFrame(gameLoop);
    }, [isPlaying, update, render, isReady]);

    useEffect(() => {
        if (isPlaying && !isLoopActive.current && isReady) {
            isLoopActive.current = true;
            rafRef.current = requestAnimationFrame(gameLoop);
        }
        return () => {
            if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
            isLoopActive.current = false;
        };
    }, [isPlaying, gameLoop, isReady]);

    if (!isReady || !stats || !internalState.current) {
        return (
            <div className="w-full flex flex-col items-center justify-center py-24 gap-4">
                <div className="w-12 h-12 border-4 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin" />
                <span className="text-[10px] uppercase font-black tracking-[0.3em] text-indigo-500">
                    Connecting to Market WASM…
                </span>
            </div>
        );
    }

    return (
        <div className="w-full flex flex-col items-center gap-0">
            <div className="flex flex-col items-center mb-8">
                <h2 className="text-2xl font-black bg-gradient-to-br from-indigo-400 to-emerald-400 bg-clip-text text-transparent uppercase tracking-[0.3em]">
                    Neuro-Trader
                </h2>
                <p className="text-[9px] text-muted-foreground uppercase tracking-[0.3em] mt-2 font-bold">
                    Evolutionary Alpha · Deep Market Prediction
                </p>
            </div>

            <div className="w-full max-w-7xl flex flex-col lg:flex-row items-center lg:items-start justify-center gap-8">
                <div className="flex flex-col gap-6 flex-shrink-0 w-80">
                    <div className="bg-card/50 border border-border rounded-2xl overflow-hidden backdrop-blur-md p-6">
                        <div className="border-b border-border pb-3 mb-5">
                            <h3 className="text-sm font-bold text-foreground uppercase tracking-tighter">
                                Neural Brain
                            </h3>
                            <p className="text-[9px] text-muted-foreground font-mono mt-0.5">
                                BEST_AGENT_LIVE_WEIGHTS
                            </p>
                        </div>
                        <TraderNetworkViz
                            population={(engine as any)?.populations.get('traders')}
                            fitnessScores={engine?.fitnessScores.get('traders')}
                        />
                        <div className="mt-5 space-y-1.5 border-t border-border pt-4">
                            <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
                                Inputs (7)
                            </p>
                            {[
                                ['I₁', 'logReturn', 'Logarithmic Returns'],
                                ['I₂', 'rsi', 'RSI (7-period)'],
                                ['I₃', 'smaCross', 'SMA 7/25 Crossover'],
                                ['I₄', 'atr', 'Volatility (ATR)'],
                                ['I₅', 'position', 'Current Position'],
                                ['I₆', 'unrealized', 'Open P&L'],
                                ['I₇', 'drawdown', 'Current Drawdown'],
                            ].map(([idx, name, desc]) => (
                                <div key={idx} className="flex items-start gap-2">
                                    <span className="text-[8px] font-mono text-indigo-500 w-5 flex-shrink-0 pt-px">{idx}</span>
                                    <div>
                                        <span className="text-[8px] font-bold text-foreground/70 font-mono">{name}</span>
                                        <p className="text-[7px] text-muted-foreground leading-tight">{desc}</p>
                                    </div>
                                </div>
                            ))}
                            <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground mb-2 mt-4 pt-2 border-t border-border">
                                Output (3) &rarr; Buy / Sell / Hold
                            </p>
                        </div>
                    </div>
                </div>

                <div className="flex flex-col items-center flex-shrink-0">
                    <TraderStatsBar 
                        stats={stats} 
                        currentPrice={internalState.current?.env.candles[internalState.current?.frame]?.close || 0}
                        rsi={internalState.current?.env.rsi || 0}
                        tick={internalState.current?.frame || 0}
                    />
                    <TraderCanvas ref={canvasRef} />
                    <GameControls
                        isPlaying={isPlaying}
                        onTogglePlay={() => setIsPlaying(p => !p)}
                        onReset={handleReset}
                    />
                    <div className="w-full mt-8">
                        <PerformanceCharts data={performanceHistory} />
                    </div>
                </div>

                <div className="hidden lg:flex flex-col gap-6 flex-shrink-0 w-80">
                    <div className="bg-card/50 border border-border rounded-2xl p-6 backdrop-blur-md">
                        <h3 className="text-xs font-bold text-indigo-500 uppercase tracking-widest mb-4">
                            Trading Strategy
                        </h3>
                        <div className="space-y-4">
                            <p className="text-xs text-muted-foreground leading-relaxed">
                                AI agents attempt to maximize <span className="text-emerald-400 font-bold">ROI</span> while 
                                minimizing <span className="text-rose-400 font-bold">Drawdown</span>. 
                                They incur transaction fees on every trade to discourage noise.
                            </p>
                            <div className="bg-indigo-500/5 rounded-xl p-3 border border-indigo-500/10">
                                <h4 className="text-[10px] font-bold text-indigo-400 uppercase mb-2">Genetic Fitness</h4>
                                <div className="text-[10px] font-mono text-muted-foreground">
                                    Fitness = ROI × (1 - MaxDrawdown)
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
