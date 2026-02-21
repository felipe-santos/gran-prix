/**
 * Target Position Renderer
 *
 * Draws the target position indicator that drones must reach
 * and maintain stability at.
 */

import { TARGET_RADIUS } from '../../../types/drone';

/**
 * Renders target position with crosshair and concentric rings
 *
 * @param ctx - Canvas rendering context
 * @param tx - Target X coordinate
 * @param ty - Target Y coordinate
 */
export function drawTarget(ctx: CanvasRenderingContext2D, tx: number, ty: number): void {
    // Outer dashed ring
    ctx.beginPath();
    ctx.arc(tx, ty, TARGET_RADIUS * 2, 0, Math.PI * 2);
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.4)'; // Emerald
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);

    // Inner target point
    ctx.beginPath();
    ctx.arc(tx, ty, TARGET_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(16, 185, 129, 0.1)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Crosshair
    ctx.beginPath();
    ctx.moveTo(tx - 10, ty);
    ctx.lineTo(tx + 10, ty);
    ctx.moveTo(tx, ty - 10);
    ctx.lineTo(tx, ty + 10);
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.8)';
    ctx.stroke();
}
