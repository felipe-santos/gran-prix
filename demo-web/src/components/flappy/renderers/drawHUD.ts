/**
 * Flappy Bird HUD Renderer
 *
 * Displays generation, score, and alive count overlay.
 */

/**
 * Renders minimal HUD: generation + score + alive printed on canvas
 *
 * @param ctx - Canvas rendering context
 * @param generation - Current generation number
 * @param score - Current game score
 * @param alive - Number of birds still alive
 */
export function drawHUD(
    ctx: CanvasRenderingContext2D,
    generation: number,
    score: number,
    alive: number,
): void {
    ctx.font = 'bold 11px Inter, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(16, 185, 129, 0.85)';
    ctx.textAlign = 'left';
    ctx.fillText(`GEN ${generation}`, 12, 20);

    ctx.fillStyle = 'rgba(200, 200, 220, 0.5)';
    ctx.fillText(`SCORE ${score}`, 12, 36);
    ctx.fillText(`ALIVE ${alive}`, 12, 52);
}
