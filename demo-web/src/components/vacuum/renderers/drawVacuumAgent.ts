/**
 * Vacuum Agent Rendering Helper
 *
 * Renders individual vacuum robot agents with battery indicators and sensor rays.
 */

import { VACUUM_SIZE, VACUUM_CELL_SIZE } from '../../../types/vacuum';

/**
 * Draws a single vacuum robot agent
 *
 * @param ctx - Canvas 2D rendering context
 * @param x - Agent X position
 * @param y - Agent Y position
 * @param heading - Agent heading angle (radians)
 * @param battery - Battery level [0..1]
 * @param color - Agent color (HSL string)
 * @param isTop - Whether this is a top performer (higher opacity)
 * @param showSensors - Whether to show sensor rays
 */
export function drawVacuumAgent(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    heading: number,
    battery: number,
    color: string,
    isTop: boolean,
    showSensors: boolean,
): void {
    ctx.save();
    ctx.translate(x, y);

    // Robot body (circular)
    ctx.globalAlpha = isTop ? 0.9 : 0.5;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, VACUUM_SIZE, 0, Math.PI * 2);
    ctx.fill();

    // Direction indicator (triangle at front)
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = isTop ? 0.8 : 0.3;
    const tipX = Math.cos(heading) * VACUUM_SIZE;
    const tipY = Math.sin(heading) * VACUUM_SIZE;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(
        Math.cos(heading + 2.5) * VACUUM_SIZE * 0.5,
        Math.sin(heading + 2.5) * VACUUM_SIZE * 0.5
    );
    ctx.lineTo(
        Math.cos(heading - 2.5) * VACUUM_SIZE * 0.5,
        Math.sin(heading - 2.5) * VACUUM_SIZE * 0.5
    );
    ctx.closePath();
    ctx.fill();

    // Battery indicator (only for top performers)
    if (isTop) {
        ctx.globalAlpha = 0.8;
        const barW = VACUUM_SIZE * 2;

        // Battery background
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(-VACUUM_SIZE, VACUUM_SIZE + 4, barW, 3);

        // Battery level (color-coded)
        ctx.fillStyle = battery > 0.5 ? '#10b981' : battery > 0.2 ? '#f59e0b' : '#ef4444';
        ctx.fillRect(-VACUUM_SIZE, VACUUM_SIZE + 4, barW * battery, 3);
    }

    // Sensor rays (only for best agent)
    if (showSensors) {
        ctx.globalAlpha = 0.25;
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);

        const sensorLen = VACUUM_CELL_SIZE * 4;
        const sensorAngles = [heading, heading - Math.PI / 3, heading + Math.PI / 3];

        for (const angle of sensorAngles) {
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(Math.cos(angle) * sensorLen, Math.sin(angle) * sensorLen);
            ctx.stroke();
        }

        ctx.setLineDash([]);
    }

    ctx.restore();
    ctx.globalAlpha = 1.0;
}
