/**
 * Charging Station Rendering Helper
 *
 * Renders the battery charging station with pulsing glow animation.
 */

/**
 * Draws the charging station with animated glow effect
 *
 * @param ctx - Canvas 2D rendering context
 * @param x - Charger X position
 * @param y - Charger Y position
 * @param frame - Current frame number (for animation)
 */
export function drawCharger(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    frame: number,
): void {
    // Pulsing glow effect
    const pulseAlpha = 0.3 + Math.sin(frame * 0.08) * 0.15;
    const glowGrad = ctx.createRadialGradient(x, y, 0, x, y, 35);
    glowGrad.addColorStop(0, `rgba(16, 185, 129, ${pulseAlpha})`);
    glowGrad.addColorStop(1, 'rgba(16, 185, 129, 0)');
    ctx.fillStyle = glowGrad;
    ctx.beginPath();
    ctx.arc(x, y, 35, 0, Math.PI * 2);
    ctx.fill();

    // Charger base (dark circle)
    ctx.fillStyle = '#1a3a2a';
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.fill();

    // Border (emerald green)
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.stroke();

    // Lightning bolt icon
    ctx.fillStyle = '#10b981';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⚡', x, y);

    // "CHARGER" label below
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#10b98188';
    ctx.font = 'bold 7px monospace';
    ctx.fillText('CHARGER', x, y + 28);
}
