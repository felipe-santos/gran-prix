/**
 * Floor Rendering Helper
 *
 * Draws the base floor with grid pattern for the vacuum simulation room.
 * Uses Feng-shui design principles with subtle grid lines.
 */

import { VACUUM_WIDTH, VACUUM_HEIGHT, VACUUM_CELL_SIZE } from '../../../types/vacuum';

/**
 * Draws the floor with gradient background and grid overlay
 *
 * @param ctx - Canvas 2D rendering context
 */
export function drawFloor(ctx: CanvasRenderingContext2D): void {
    // Gradient background (warm wood tone)
    const grad = ctx.createLinearGradient(0, 0, 0, VACUUM_HEIGHT);
    grad.addColorStop(0, '#2a2218');
    grad.addColorStop(1, '#1e1a14');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, VACUUM_WIDTH, VACUUM_HEIGHT);

    // Grid lines (subtle)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;

    // Vertical lines
    for (let x = 0; x < VACUUM_WIDTH; x += VACUUM_CELL_SIZE) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, VACUUM_HEIGHT);
        ctx.stroke();
    }

    // Horizontal lines
    for (let y = 0; y < VACUUM_HEIGHT; y += VACUUM_CELL_SIZE) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(VACUUM_WIDTH, y);
        ctx.stroke();
    }

    // Room border (stronger outline)
    ctx.strokeStyle = '#5a4a3a';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, VACUUM_WIDTH - 4, VACUUM_HEIGHT - 4);
}
