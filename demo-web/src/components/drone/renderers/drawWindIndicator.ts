/**
 * Wind Indicator Renderer
 *
 * Displays current wind forces affecting drone stability.
 * Shows both numeric values and directional vector.
 */

import { DRONE_WIDTH } from '../../../types/drone';

/**
 * Renders wind direction and magnitude indicator
 *
 * @param ctx - Canvas rendering context
 * @param windX - Wind force in X direction
 * @param windY - Wind force in Y direction
 */
export function drawWindIndicator(
    ctx: CanvasRenderingContext2D,
    windX: number,
    windY: number,
): void {
    ctx.font = 'bold 10px Inter';
    ctx.fillStyle = 'rgba(239, 68, 68, 0.8)'; // Red for wind
    ctx.textAlign = 'right';
    ctx.fillText(`WIND: ${(windX * 100).toFixed(1)} / ${(windY * 100).toFixed(1)}`, DRONE_WIDTH - 20, 20);

    // Draw wind vector
    ctx.beginPath();
    ctx.moveTo(DRONE_WIDTH - 50, 40);
    ctx.lineTo(DRONE_WIDTH - 50 + windX * 150, 40 + windY * 150);
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.8)';
    ctx.lineWidth = 2;
    ctx.stroke();
}
