/**
 * Drone Background Renderer
 *
 * Draws the atmospheric sky background with grid overlay
 * for the drone stabilizer demo.
 */

import { DRONE_WIDTH, DRONE_HEIGHT } from '../../../types/drone';

/**
 * Renders sky background with atmospheric grid
 *
 * @param ctx - Canvas rendering context
 * @param isDark - Whether dark theme is active
 */
export function drawBackground(ctx: CanvasRenderingContext2D, isDark: boolean): void {
    const trailColor = isDark
        ? 'rgba(8, 8, 12, 1)'
        : 'rgba(248, 248, 249, 1)';
    ctx.fillStyle = trailColor;
    ctx.fillRect(0, 0, DRONE_WIDTH, DRONE_HEIGHT);

    const gridColor = isDark
        ? 'rgba(255,255,255,0.025)'
        : 'rgba(0,0,0,0.025)';
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;

    for (let x = 0; x < DRONE_WIDTH; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, DRONE_HEIGHT);
        ctx.stroke();
    }
    for (let y = 0; y < DRONE_HEIGHT; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(DRONE_WIDTH, y);
        ctx.stroke();
    }
}
