/**
 * Mini Dust Map Rendering Helper
 *
 * Renders a small heat-map overview of dust coverage in the room.
 */

/**
 * Draws a miniaturized dust coverage map
 *
 * @param ctx - Canvas 2D rendering context
 * @param dustMap - Flat boolean array (true = dirty cell)
 * @param cols - Number of grid columns
 * @param rows - Number of grid rows
 * @param mapX - Mini-map X position on canvas
 * @param mapY - Mini-map Y position on canvas
 * @param mapW - Mini-map width
 * @param mapH - Mini-map height
 */
export function drawMiniDustMap(
    ctx: CanvasRenderingContext2D,
    dustMap: boolean[],
    cols: number,
    rows: number,
    mapX: number,
    mapY: number,
    mapW: number,
    mapH: number,
): void {
    // Background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(mapX, mapY, mapW, mapH);

    // Border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.strokeRect(mapX, mapY, mapW, mapH);

    // Label
    ctx.fillStyle = '#ffffff88';
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('DUST MAP', mapX + 4, mapY + 10);

    // Grid cells
    const cellW = (mapW - 8) / cols;
    const cellH = (mapH - 18) / rows;

    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const idx = row * cols + col;
            const isDirty = dustMap[idx];

            // Color: dirty = brownish, clean = emerald
            ctx.fillStyle = isDirty
                ? 'rgba(180, 140, 80, 0.6)'
                : 'rgba(16, 185, 129, 0.15)';

            ctx.fillRect(
                mapX + 4 + col * cellW,
                mapY + 14 + row * cellH,
                cellW - 0.5,
                cellH - 0.5
            );
        }
    }
}
