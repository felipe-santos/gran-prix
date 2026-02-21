/**
 * HUD (Heads-Up Display) Rendering Helper
 *
 * Renders on-screen statistics and information overlay.
 */

import { VACUUM_WIDTH, VACUUM_MAX_FRAMES } from '../../../types/vacuum';

/**
 * Agent stats for HUD display
 */
export interface BestAgentStats {
    dustCleaned: number;
    battery: number;
    wallHits: number;
}

/**
 * Draws the HUD overlay with generation stats and best agent info
 *
 * @param ctx - Canvas 2D rendering context
 * @param generation - Current generation number
 * @param frame - Current frame in generation
 * @param alive - Number of alive agents
 * @param bestAgent - Best agent's stats (or null if none)
 * @param totalDust - Total dust cells in environment
 */
export function drawHUD(
    ctx: CanvasRenderingContext2D,
    generation: number,
    frame: number,
    alive: number,
    bestAgent: BestAgentStats | null,
    totalDust: number,
): void {
    // Left side - Generation info
    ctx.font = 'bold 11px Inter, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(16, 185, 129, 0.85)';
    ctx.textAlign = 'left';
    ctx.fillText(`GEN ${generation}`, 12, 20);

    ctx.fillStyle = 'rgba(200, 200, 220, 0.5)';
    ctx.fillText(`FRAME ${frame} / ${VACUUM_MAX_FRAMES}`, 12, 36);
    ctx.fillText(`ALIVE ${alive}`, 12, 52);

    // Right side - Best agent stats
    if (bestAgent) {
        const pct = totalDust > 0 ? ((bestAgent.dustCleaned / totalDust) * 100).toFixed(1) : '0';

        ctx.fillStyle = 'rgba(16, 185, 129, 0.7)';
        ctx.textAlign = 'right';
        ctx.fillText(`BEST: ${pct}% cleaned`, VACUUM_WIDTH - 12, 20);

        // Battery indicator (color-coded)
        const batteryColor = bestAgent.battery > 0.3
            ? 'rgba(16, 185, 129, 0.6)'
            : 'rgba(239, 68, 68, 0.7)';
        ctx.fillStyle = batteryColor;
        ctx.fillText(`🔋 ${(bestAgent.battery * 100).toFixed(0)}%`, VACUUM_WIDTH - 12, 36);
    }
}
