/**
 * Vacuum Demo Rendering Helpers
 *
 * This module provides pure rendering functions for the Smart Vacuum demo.
 * All functions are stateless and side-effect free (except for canvas drawing).
 *
 * ## Architecture
 * Each renderer is responsible for drawing a specific visual element:
 * - Floor & grid
 * - Dust particles
 * - Obstacles (furniture)
 * - Charging station
 * - Vacuum agents
 * - Mini dust map
 * - HUD overlay
 *
 * ## Usage
 * ```typescript
 * import { drawFloor, drawDust, drawVacuumAgent } from './renderers';
 *
 * function render(ctx: CanvasRenderingContext2D) {
 *     drawFloor(ctx);
 *     drawDust(ctx, dustMap, cols, rows);
 *     drawVacuumAgent(ctx, x, y, heading, battery, color, true, false);
 * }
 * ```
 */

export { drawFloor } from './drawFloor';
export { drawDust } from './drawDust';
export { drawObstacles } from './drawObstacles';
export { drawCharger } from './drawCharger';
export { drawVacuumAgent } from './drawVacuumAgent';
export { drawMiniDustMap } from './drawMiniDustMap';
export { drawHUD, type BestAgentStats } from './drawHUD';
