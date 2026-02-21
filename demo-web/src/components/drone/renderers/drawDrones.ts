/**
 * Neural Drones Renderer
 *
 * Renders the neural network-controlled drones (white/black circles)
 * that are learning to stabilize.
 */

import { DRONE_SIZE } from '../../../types/drone';

/**
 * Renders all neural network drones
 *
 * @param ctx - Canvas rendering context
 * @param drones - Array of drone positions and states
 * @param isDark - Whether dark theme is active
 */
export function drawDrones(
    ctx: CanvasRenderingContext2D,
    drones: { x: number; y: number; dead: boolean; color: string }[],
    isDark: boolean,
): void {
    drones.forEach(drone => {
        if (drone.dead) return; // Keep it clean, don't draw dead drones for this demo

        ctx.globalAlpha = 0.6;
        ctx.fillStyle = isDark ? '#fff' : '#000'; // Neural drones are white/black

        ctx.beginPath();
        ctx.arc(drone.x, drone.y, DRONE_SIZE / 2, 0, Math.PI * 2);
        ctx.fill();
    });
    ctx.globalAlpha = 1.0;
}
