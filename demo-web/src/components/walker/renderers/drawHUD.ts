/**
 * Walker HUD Renderer
 *
 * Displays generation, frame, and alive count overlay
 * for the bipedal walker demo.
 */

/**
 * Renders minimal HUD: generation + frame + alive printed on canvas
 *
 * @param ctx - Canvas rendering context
 * @param generation - Current generation number
 * @param frame - Current frame number
 * @param alive - Number of walkers still alive
 */
export function drawHUD(
    ctx: CanvasRenderingContext2D,
    generation: number,
    frame: number,
    alive: number,
): void {
    ctx.font = 'bold 11px Inter, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(16, 185, 129, 0.85)';
    ctx.textAlign = 'left';
    ctx.fillText(`GEN ${generation}`, 12, 20);

    ctx.fillStyle = 'rgba(200, 200, 220, 0.5)';
    ctx.fillText(`FRAME ${frame}`, 12, 36);
    ctx.fillText(`ALIVE ${alive}`, 12, 52);
}
