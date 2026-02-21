/**
 * Flappy Birds Renderer
 *
 * Draws all bird agents (alive as bright ellipses, dead as dim).
 */

import { FLAPPY_BIRD_SIZE } from '../../../types/flappy';

const BIRD_X = 80;

/**
 * Renders all birds in the population
 *
 * @param ctx - Canvas rendering context
 * @param birds - Array of bird positions and states
 * @param isDark - Whether dark theme is active
 */
export function drawBirds(
    ctx: CanvasRenderingContext2D,
    birds: { y: number; dead: boolean; color: string }[],
    isDark: boolean,
): void {
    birds.forEach(bird => {
        const cx = BIRD_X + FLAPPY_BIRD_SIZE / 2;
        const cy = bird.y;
        const rx = FLAPPY_BIRD_SIZE / 2;
        const ry = FLAPPY_BIRD_SIZE / 2.4;

        if (bird.dead) {
            ctx.globalAlpha = isDark ? 0.08 : 0.12;
            ctx.fillStyle = isDark ? '#333' : '#ccc';
        } else {
            ctx.globalAlpha = 0.92;
            ctx.fillStyle = bird.color;
        }

        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
    });

    ctx.globalAlpha = 1.0;
}
