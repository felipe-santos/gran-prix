/**
 * Obstacle Rendering Helper
 *
 * Renders furniture obstacles (sofas, tables, etc.) with 3D-like styling.
 */

import { VacuumObstacle } from '../../../types/vacuum';

/**
 * Draws furniture obstacles with labels
 *
 * @param ctx - Canvas 2D rendering context
 * @param obstacles - Array of furniture obstacles with positions and labels
 */
export function drawObstacles(ctx: CanvasRenderingContext2D, obstacles: VacuumObstacle[]): void {
    for (const obstacle of obstacles) {
        // Main furniture body
        ctx.fillStyle = '#3a3028';
        ctx.fillRect(obstacle.x, obstacle.y, obstacle.w, obstacle.h);

        // Border (3D effect)
        ctx.strokeStyle = '#5a4a38';
        ctx.lineWidth = 2;
        ctx.strokeRect(obstacle.x, obstacle.y, obstacle.w, obstacle.h);

        // Inner highlight (3D depth)
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
        ctx.lineWidth = 1;
        ctx.strokeRect(obstacle.x + 4, obstacle.y + 4, obstacle.w - 8, obstacle.h - 8);

        // Label text
        ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.font = 'bold 8px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(obstacle.label, obstacle.x + obstacle.w / 2, obstacle.y + obstacle.h / 2);
    }

    // Reset text baseline
    ctx.textBaseline = 'alphabetic';
}
