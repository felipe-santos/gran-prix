/**
 * Walker Background Renderer
 *
 * Draws the atmospheric background with grid overlay
 * for the bipedal walker demo.
 */

import { WALKER_WIDTH, WALKER_HEIGHT } from '../../../types/walker';

/**
 * Renders background grid (Feng-Shui grid matches other demos)
 *
 * @param ctx - Canvas rendering context
 * @param isDark - Whether dark theme is active
 */
export function drawBackground(ctx: CanvasRenderingContext2D, isDark: boolean): void {
    const trailColor = isDark
        ? 'rgba(8, 8, 12, 0.85)'
        : 'rgba(248, 248, 249, 0.85)';
    ctx.fillStyle = trailColor;
    ctx.fillRect(0, 0, WALKER_WIDTH, WALKER_HEIGHT);

    const gridColor = isDark
        ? 'rgba(255,255,255,0.02)'
        : 'rgba(0,0,0,0.02)';
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;

    for (let x = 0; x < WALKER_WIDTH; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, WALKER_HEIGHT);
        ctx.stroke();
    }
    for (let y = 0; y < WALKER_HEIGHT; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(WALKER_WIDTH, y);
        ctx.stroke();
    }
}
