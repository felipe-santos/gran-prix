/**
 * Dust Rendering Helper
 *
 * Renders dust particles on the floor grid with realistic particle effects.
 */

import { VACUUM_CELL_SIZE } from '../../../types/vacuum';

/**
 * Draws dust particles on dirty cells
 *
 * @param ctx - Canvas 2D rendering context
 * @param dustMap - Flat boolean array (true = dirty cell)
 * @param cols - Number of grid columns
 * @param rows - Number of grid rows
 */
export function drawDust(
    ctx: CanvasRenderingContext2D,
    dustMap: boolean[],
    cols: number,
    rows: number,
): void {
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const idx = row * cols + col;
            if (!dustMap[idx]) continue;

            const x = col * VACUUM_CELL_SIZE;
            const y = row * VACUUM_CELL_SIZE;

            // Main dust cluster
            ctx.fillStyle = 'rgba(180, 160, 130, 0.35)';
            ctx.beginPath();
            ctx.arc(
                x + VACUUM_CELL_SIZE * 0.5,
                y + VACUUM_CELL_SIZE * 0.5,
                VACUUM_CELL_SIZE * 0.3,
                0,
                Math.PI * 2
            );
            ctx.fill();

            // Small dust particles (details)
            ctx.fillStyle = 'rgba(160, 140, 110, 0.25)';
            ctx.beginPath();
            ctx.arc(x + VACUUM_CELL_SIZE * 0.3, y + VACUUM_CELL_SIZE * 0.35, 2, 0, Math.PI * 2);
            ctx.fill();

            ctx.beginPath();
            ctx.arc(x + VACUUM_CELL_SIZE * 0.7, y + VACUUM_CELL_SIZE * 0.65, 1.5, 0, Math.PI * 2);
            ctx.fill();
        }
    }
}
