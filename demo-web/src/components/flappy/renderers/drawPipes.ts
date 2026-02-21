/**
 * Flappy Bird Pipes Renderer
 *
 * Draws pipe obstacles with gradient and caps.
 */

import { FLAPPY_PIPE_WIDTH, FLAPPY_HEIGHT } from '../../../types/flappy';

/**
 * Renders pipe pairs (top and bottom with gaps)
 *
 * @param ctx - Canvas rendering context
 * @param pipes - Array of pipe positions and gap coordinates
 */
export function drawPipes(
    ctx: CanvasRenderingContext2D,
    pipes: { x: number; gapTop: number; gapBottom: number }[],
): void {
    pipes.forEach(pipe => {
        // Top pipe
        const grad = ctx.createLinearGradient(pipe.x, 0, pipe.x + FLAPPY_PIPE_WIDTH, 0);
        grad.addColorStop(0, '#15803d');
        grad.addColorStop(1, '#16a34a');
        ctx.fillStyle = grad;

        // Top pipe body
        ctx.beginPath();
        ctx.roundRect(pipe.x, 0, FLAPPY_PIPE_WIDTH, pipe.gapTop - 12, [0, 0, 6, 6]);
        ctx.fill();

        // Top pipe cap
        ctx.fillStyle = '#22c55e';
        ctx.beginPath();
        ctx.roundRect(pipe.x - 4, pipe.gapTop - 20, FLAPPY_PIPE_WIDTH + 8, 20, [4, 4, 4, 4]);
        ctx.fill();

        // Bottom pipe body
        const grad2 = ctx.createLinearGradient(pipe.x, 0, pipe.x + FLAPPY_PIPE_WIDTH, 0);
        grad2.addColorStop(0, '#15803d');
        grad2.addColorStop(1, '#16a34a');
        ctx.fillStyle = grad2;

        ctx.beginPath();
        ctx.roundRect(pipe.x, pipe.gapBottom + 12, FLAPPY_PIPE_WIDTH, FLAPPY_HEIGHT - pipe.gapBottom - 12, [6, 6, 0, 0]);
        ctx.fill();

        // Bottom pipe cap
        ctx.fillStyle = '#22c55e';
        ctx.beginPath();
        ctx.roundRect(pipe.x - 4, pipe.gapBottom, FLAPPY_PIPE_WIDTH + 8, 20, [4, 4, 4, 4]);
        ctx.fill();
    });
}
