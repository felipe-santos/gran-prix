import { useEffect, useRef, useState, useCallback } from 'react';
import * as wasm from '../../wasm/pkg/gran_prix_wasm';

import {
    TRADER_WIDTH,
    TRADER_HEIGHT,
    TRADER_POPULATION_SIZE,
    TRADER_INITIAL_CAPITAL,
    TRADER_MAX_FRAMES,
    Candle,
    TraderStats,
} from '../../types';
import { PerformanceData, PerformanceCharts } from '../PerformanceCharts';
import { useTraderWasm } from '../../hooks/useTraderWasm';
import { useTraderGameLoop } from '../../hooks/useTraderGameLoop';

import { TraderCanvas } from './TraderCanvas';
import { TraderStatsBar } from './TraderStatsBar';
import { TraderNetworkViz } from './TraderNetworkViz';
import { GameControls } from '../GameControls';

const DEFAULT_MUTATION_RATE = 0.18;
const DEFAULT_MUTATION_SCALE = 0.5;

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
    // Determine visible window (last 80 candles)
    const visibleCount = 80;
    const startTick = Math.max(0, currentTick - visibleCount);
    const endTick = Math.min(candles.length, currentTick + 1);
    const visibleCandles = candles.slice(startTick, endTick);

    if (visibleCandles.length === 0) return;

    // Price range
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

    // Draw price labels
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

    // Chart border
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.strokeRect(CHART_LEFT, CHART_TOP, CHART_WIDTH, CHART_HEIGHT);

    // Draw candles
    const candleWidth = Math.max(2, Math.floor(CHART_WIDTH / visibleCount) - 1);
    const wickWidth = 1;

    visibleCandles.forEach((candle, i) => {
        const x = CHART_LEFT + (i / visibleCount) * CHART_WIDTH + candleWidth / 2;
        const isGreen = candle.close >= candle.open;

        const bodyTop = priceToPx(Math.max(candle.open, candle.close));
        const bodyBottom = priceToPx(Math.min(candle.open, candle.close));
        const bodyHeight = Math.max(1, bodyBottom - bodyTop);

        // Wick
        ctx.strokeStyle = isGreen ? '#26a69a' : '#ef5350';
        ctx.lineWidth = wickWidth;
        ctx.beginPath();
        ctx.moveTo(x, priceToPx(candle.high));
        ctx.lineTo(x, priceToPx(candle.low));
        ctx.stroke();

        // Body
        ctx.fillStyle = isGreen ? '#26a69a' : '#ef5350';
        ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
    });

    // Draw trade markers from best agent
    bestTrades.forEach(trade => {
        if (trade.tick < startTick || trade.tick > endTick) return;
        const localIdx = trade.tick - startTick;
        const x = CHART_LEFT + (localIdx / visibleCount) * CHART_WIDTH + candleWidth / 2;
        const y = priceToPx(trade.price);

        if (trade.action === 'buy') {
            // Green triangle up
            ctx.fillStyle = '#10b981';
            ctx.beginPath();
            ctx.moveTo(x, y + 12);
            ctx.lineTo(x - 5, y + 20);
            ctx.lineTo(x + 5, y + 20);
            ctx.closePath();
            ctx.fill();

            ctx.fillStyle = '#10b981';
            ctx.font = 'bold 7px monospace';
            ctx.textAlign = 'center';
            ctx.fillText('B', x, y + 29);
        } else {
            // Red triangle down
            ctx.fillStyle = '#ef4444';
            ctx.beginPath();
            ctx.moveTo(x, y - 12);
            ctx.lineTo(x - 5, y - 20);
            ctx.lineTo(x + 5, y - 20);
            ctx.closePath();
            ctx.fill();

            ctx.fillStyle = '#ef4444';
            ctx.font = 'bold 7px monospace';
            ctx.textAlign = 'center';
            ctx.fillText('S', x, y - 24);
        }
    });

    // Title
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('NEURAL-ASSET/USD', CHART_LEFT + 5, CHART_TOP + 15);
}

function drawRSIPanel(ctx: CanvasRenderingContext2D, rsi: number) {
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.strokeRect(CHART_LEFT, INDICATOR_TOP, CHART_WIDTH, INDICATOR_HEIGHT);

    // Overbought/oversold zones
    const obY = INDICATOR_TOP + (1 - 70 / 100) * INDICATOR_HEIGHT;
    const osY = INDICATOR_TOP + (1 - 30 / 100) * INDICATOR_HEIGHT;

    ctx.fillStyle = 'rgba(239, 68, 68, 0.05)';
    ctx.fillRect(CHART_LEFT, INDICATOR_TOP, CHART_WIDTH, obY - INDICATOR_TOP);

    ctx.fillStyle = 'rgba(16, 185, 129, 0.05)';
    ctx.fillRect(CHART_LEFT, osY, CHART_WIDTH, INDICATOR_TOP + INDICATOR_HEIGHT - osY);

    // 70/30 lines
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.3)';
    ctx.beginPath();
    ctx.moveTo(CHART_LEFT, obY);
    ctx.lineTo(CHART_LEFT + CHART_WIDTH, obY);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(16, 185, 129, 0.3)';
    ctx.beginPath();
    ctx.moveTo(CHART_LEFT, osY);
    ctx.lineTo(CHART_LEFT + CHART_WIDTH, osY);
    ctx.stroke();
    ctx.setLineDash([]);

    // RSI value marker
    const rsiY = INDICATOR_TOP + (1 - rsi / 100) * INDICATOR_HEIGHT;
    const rsiColor = rsi > 70 ? '#ef4444' : rsi < 30 ? '#10b981' : '#f59e0b';

    ctx.fillStyle = rsiColor;
    ctx.beginPath();
    ctx.arc(CHART_LEFT + CHART_WIDTH - 10, rsiY, 4, 0, Math.PI * 2);
    ctx.fill();

    // Label
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`RSI(7): ${rsi.toFixed(0)}`, CHART_LEFT + 5, INDICATOR_TOP + 10);
}

function drawEquityCurve(
    ctx: CanvasRenderingContext2D,
    agents: { capital: number; dead: boolean }[],
) {
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.strokeRect(CHART_LEFT, EQUITY_TOP, CHART_WIDTH, EQUITY_HEIGHT);

    // Find best agent
    const sorted = [...agents].filter(a => !a.dead).sort((a, b) => b.capital - a.capital);
    if (sorted.length === 0) return;

    const bestCapital = sorted[0].capital;
    const worstCapital = sorted[sorted.length - 1]?.capital ?? bestCapital;

    // Distribution bar
    const barWidth = CHART_WIDTH - 20;
    const barX = CHART_LEFT + 10;
    const barY = EQUITY_TOP + 20;
    const barH = 12;

    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(barX, barY, barWidth, barH);

    // Color each agent as a tiny segment
    const segW = barWidth / agents.length;
    const capitalSorted = [...agents].sort((a, b) => a.capital - b.capital);

    capitalSorted.forEach((agent, i) => {
        const roi = agent.capital / TRADER_INITIAL_CAPITAL;
        const color = roi >= 1 ? `rgba(16, 185, 129, ${Math.min(1, roi - 0.5)})` : `rgba(239, 68, 68, ${Math.min(1, 1.5 - roi)})`;
        ctx.fillStyle = color;
        ctx.fillRect(barX + i * segW, barY, Math.max(1, segW), barH);
    });

    // Labels
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('PORTFOLIO DISTRIBUTION', CHART_LEFT + 5, EQUITY_TOP + 12);

    ctx.font = 'bold 9px monospace';
    ctx.fillStyle = '#10b981';
    ctx.fillText(`Best: $${bestCapital.toFixed(0)} (${((bestCapital / TRADER_INITIAL_CAPITAL - 1) * 100).toFixed(1)}%)`, barX, barY + barH + 14);

    ctx.fillStyle = '#ef4444';
    ctx.textAlign = 'right';
    ctx.fillText(`Worst: $${worstCapital.toFixed(0)} (${((worstCapital / TRADER_INITIAL_CAPITAL - 1) * 100).toFixed(1)}%)`, barX + barWidth, barY + barH + 14);

    // Alive count
    const alive = agents.filter(a => !a.dead).length;
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.textAlign = 'center';
    ctx.fillText(`${alive}/${agents.length} traders alive`, barX + barWidth / 2, barY + barH + 28);
}

function drawHUD(ctx: CanvasRenderingContext2D, generation: number, tick: number) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(TRADER_WIDTH - 180, 5, 175, 22);
    ctx.fillStyle = '#ffffff88';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`GEN ${generation} | CANDLE ${tick}/${TRADER_MAX_FRAMES}`, TRADER_WIDTH - 12, 19);
}

// ─── Main Component ────────────────────────────────────────────────────────────

export function TraderDemo() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [stats, setStats] = useState<TraderStats>({
        generation: 1, bestROI: 1, avgROI: 1, bestDrawdown: 0, alive: TRADER_POPULATION_SIZE,
    });
    const [performanceHistory, setPerformanceHistory] = useState<PerformanceData[]>([]);

    const { population, initTraderWasm, computeTrader, evolveTrader } = useTraderWasm();

    const evolve = useCallback((
        fitnessScores: number[],
        rate: number,
        scale: number,
        strategy: wasm.MutationStrategy,
    ) => {
        evolveTrader(fitnessScores, rate, scale, strategy);
    }, [evolveTrader]);

    const onGenerationEnd = useCallback((maxFitness: number, avgFitness: number) => {
        setPerformanceHistory(prev => {
            const nextGen = prev.length > 0 ? prev[prev.length - 1].generation + 1 : 1;
            const newHistory = [...prev, { generation: nextGen, avg: avgFitness, max: maxFitness }];
            return newHistory.slice(-50);
        });
    }, []);

    const { gameState, resetTrader, updatePhysics } = useTraderGameLoop({
        computeTrader,
        evolve,
        setStats,
        mutationRate: DEFAULT_MUTATION_RATE,
        mutationScale: DEFAULT_MUTATION_SCALE,
        mutationStrategy: wasm.MutationStrategy.Additive,
        onGenerationEnd,
    });

    // Init WASM
    useEffect(() => {
        if (!population) {
            initTraderWasm().then(() => {
                resetTrader();
            });
        }
    }, [initTraderWasm, population, resetTrader]);


    // Render
    const render = useCallback((ctx: CanvasRenderingContext2D) => {
        const state = gameState.current;
        const { env, agents, bestTrades } = state;

        drawBackground(ctx);
        drawCandlestickChart(ctx, env.candles, env.tick, bestTrades);
        drawRSIPanel(ctx, env.rsi);
        drawEquityCurve(ctx, agents);
        drawHUD(ctx, state.generation, env.tick);
    }, [gameState]);

    // Game loop
    const rafId = useRef<number | null>(null);
    const isLoopActive = useRef(false);

    const gameLoop = useCallback(() => {
        if (!isPlaying) {
            isLoopActive.current = false;
            return;
        }
        if (!canvasRef.current) {
            rafId.current = requestAnimationFrame(gameLoop);
            return;
        }

        const ctx = canvasRef.current.getContext('2d');
        if (!ctx) return;

        // Run 3 ticks per frame for speed (500 candles in ~10 sec)
        for (let i = 0; i < 3; i++) {
            updatePhysics();
        }

        render(ctx);
        rafId.current = requestAnimationFrame(gameLoop);
    }, [isPlaying, updatePhysics, render]);

    useEffect(() => {
        if (isPlaying && !isLoopActive.current) {
            isLoopActive.current = true;
            rafId.current = requestAnimationFrame(gameLoop);
        }
        return () => {
            if (rafId.current) cancelAnimationFrame(rafId.current);
            isLoopActive.current = false;
        };
    }, [isPlaying, gameLoop]);

    return (
        <div className="flex flex-col items-center gap-6 w-full max-w-5xl">
            <TraderStatsBar
                stats={stats}
                currentPrice={gameState.current.env.currentPrice}
                rsi={gameState.current.env.rsi}
                tick={gameState.current.env.tick}
            />

            <TraderCanvas ref={canvasRef} />

            <GameControls
                isPlaying={isPlaying}
                onTogglePlay={() => setIsPlaying(!isPlaying)}
                onReset={() => {
                    resetTrader();
                    setStats({ generation: 1, bestROI: 1, avgROI: 1, bestDrawdown: 0, alive: TRADER_POPULATION_SIZE });
                    setPerformanceHistory([]);
                }}
                isRestarting={false}
            />

            <div className="w-full flex flex-col lg:flex-row gap-6">
                <div className="flex-1">
                    <PerformanceCharts data={performanceHistory} />
                </div>
                <div className="w-full lg:w-80">
                    <TraderNetworkViz 
                        population={population} 
                        fitnessScores={Float32Array.from(gameState.current.agents.map(a => a.fitness))} 
                    />
                </div>
            </div>
        </div>
    );
}
