/**
 * PID Reference Drone Renderer
 *
 * Draws the mathematically-controlled PID baseline drone (orange)
 * that serves as performance reference for neural networks.
 */

import { DRONE_SIZE } from '../../../types/drone';

/**
 * Renders the PID controller reference drone
 *
 * @param ctx - Canvas rendering context
 * @param pidDrone - PID drone position and color
 */
export function drawPidDrone(
    ctx: CanvasRenderingContext2D,
    pidDrone: { x: number; y: number; color: string },
): void {
    ctx.fillStyle = pidDrone.color; // Orange for PID Reference
    ctx.beginPath();
    ctx.arc(pidDrone.x, pidDrone.y, DRONE_SIZE / 1.5, 0, Math.PI * 2);
    ctx.fill();

    // Outline for PID Drone
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Small label 'PID' above it
    ctx.font = 'bold 10px Inter';
    ctx.fillStyle = pidDrone.color;
    ctx.textAlign = 'center';
    ctx.fillText('PID', pidDrone.x, pidDrone.y - 15);
}
