/**
 * Flappy Bird Background Renderer
 *
 * Draws the atmospheric background with grid overlay.
 */

import { FLAPPY_WIDTH, FLAPPY_HEIGHT } from '../../../types/flappy';

/**
 * Renders background grid (Feng-Shui grid matches other demos)
 *
 * @param ctx - Canvas rendering context
 * @param isDark - Whether dark theme is active
 */
export function drawBackground(ctx: CanvasRenderingContext2D, isDark: boolean): void {
    const trailColor = isDark
        ? 'rgba(8, 8, 12, 0.7)'
        : 'rgba(248, 248, 249, 0.7)';
    ctx.fillStyle = trailColor;
    ctx.fillRect(0, 0, FLAPPY_WIDTH, FLAPPY_HEIGHT);

    const gridColor = isDark
        ? 'rgba(255,255,255,0.025)'
        : 'rgba(0,0,0,0.025)';
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;

    for (let x = 0; x < FLAPPY_WIDTH; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, FLAPPY_HEIGHT);
        ctx.stroke();
    }
    for (let y = 0; y < FLAPPY_HEIGHT; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(FLAPPY_WIDTH, y);
        ctx.stroke();
    }
}
