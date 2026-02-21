import type { OvenAgent } from '../../../types';
import { OVEN_CANVAS_WIDTH, OVEN_CANVAS_HEIGHT } from '../OvenCanvas';
import { getHeatColor } from './getHeatColor';

/**
 * Draws the complete oven visualization including heaters, fan, and food
 * @param ctx - Canvas rendering context
 * @param bestAgent - Best performing agent to visualize
 * @param ambientTemp - Ambient room temperature
 * @param maxTemp - Maximum oven temperature
 */
export function drawOven(
    ctx: CanvasRenderingContext2D,
    bestAgent: OvenAgent | null,
    ambientTemp: number,
    maxTemp: number
): void {
    // Draw base oven metallic interior
    ctx.fillStyle = '#1a1a1c';
    ctx.fillRect(0, 0, OVEN_CANVAS_WIDTH, OVEN_CANVAS_HEIGHT);

    if (!bestAgent) return;

    const w = OVEN_CANVAS_WIDTH;
    const h = OVEN_CANVAS_HEIGHT;

    // Air gradient glow
    const airGrad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * 0.8);
    airGrad.addColorStop(0, getHeatColor(bestAgent.airTemp, ambientTemp, maxTemp));
    airGrad.addColorStop(1, '#111');
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = airGrad;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1.0;

    // Draw Top Heater
    ctx.fillStyle = getHeatColor(ambientTemp + bestAgent.topHeater * (maxTemp - ambientTemp), ambientTemp, maxTemp);
    ctx.fillRect(w * 0.1, 20, w * 0.8, 15);
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 2;
    ctx.strokeRect(w * 0.1, 20, w * 0.8, 15);

    // Draw Bottom Heater
    ctx.fillStyle = getHeatColor(ambientTemp + bestAgent.bottomHeater * (maxTemp - ambientTemp), ambientTemp, maxTemp);
    ctx.fillRect(w * 0.1, h - 35, w * 0.8, 15);
    ctx.strokeRect(w * 0.1, h - 35, w * 0.8, 15);

    // Draw Fan (spinning if active)
    if (bestAgent.fan > 0.5) {
        ctx.save();
        ctx.translate(w - 40, h / 2);
        const time = Date.now() / 50;
        ctx.rotate(time);
        ctx.fillStyle = 'rgba(200, 200, 255, 0.4)';
        ctx.beginPath();
        for (let i = 0; i < 4; i++) {
            ctx.moveTo(0, 0);
            ctx.arc(0, 0, 20, i * Math.PI / 2, i * Math.PI / 2 + 0.5);
            ctx.lineTo(0, 0);
        }
        ctx.fill();
        ctx.restore();
    }
    // Fan housing
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(w - 40, h / 2, 22, 0, Math.PI * 2);
    ctx.stroke();

    // Draw Food
    const foodY = h * 0.6;
    const foodW = 160;
    const foodH = 80;

    // Grill rack
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(20, foodY + foodH / 2);
    ctx.lineTo(w - 20, foodY + foodH / 2);
    for (let x = 30; x < w - 20; x += 15) {
        ctx.moveTo(x, foodY + foodH / 2 - 5);
        ctx.lineTo(x, foodY + foodH / 2 + 5);
    }
    ctx.stroke();

    ctx.save();
    ctx.translate(w / 2, foodY);

    // Food Surface (outer ellipse)
    ctx.fillStyle = getHeatColor(bestAgent.surfaceTemp, ambientTemp, maxTemp);
    if (bestAgent.burnt) ctx.fillStyle = '#000'; // completely burnt
    ctx.beginPath();
    ctx.ellipse(0, 0, foodW / 2, foodH / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = bestAgent.burnt ? '#ff0000' : '#885533';
    ctx.lineWidth = 4;
    ctx.stroke();

    // Food Core (inner ellipse)
    ctx.fillStyle = getHeatColor(bestAgent.coreTemp, ambientTemp, maxTemp);
    ctx.beginPath();
    ctx.ellipse(0, 0, foodW / 4, foodH / 4, 0, 0, Math.PI * 2);
    ctx.fill();

    // Text labels on food
    ctx.fillStyle = 'white';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${bestAgent.food.type}`, 0, -foodH / 2 - 10);

    ctx.font = '10px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText(`C: ${bestAgent.coreTemp.toFixed(1)}°`, 0, 4);
    ctx.fillText(`S: ${bestAgent.surfaceTemp.toFixed(1)}°`, 0, foodH / 2 - 8);

    ctx.restore();

    // HUD Text
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.textAlign = 'left';
    ctx.font = '11px Inter, sans-serif';
    ctx.fillText(`TARGET CORE: ${bestAgent.food.targetCore}°C`, 10, 50);
    ctx.fillText(`BURN LIMIT:  ${bestAgent.food.burnTemp}°C`, 10, 65);
    ctx.fillText(`ENERGY USED: ${bestAgent.energyUsed.toFixed(0)}`, 10, 80);
    if (bestAgent.cooked && (!bestAgent.burnt)) {
        ctx.fillStyle = '#10b981';
        ctx.font = 'bold 14px monospace';
        ctx.fillText('PERFECTLY COOKED! 🏆', 10, 100);
        ctx.fillStyle = '#06b6d4';
        ctx.fillText('RESTING / CARRYOVER', 10, 115);
    } else if (bestAgent.burnt) {
        ctx.fillStyle = '#ef4444';
        ctx.font = 'bold 14px monospace';
        ctx.fillText('BURNT! ❌', 10, 100);
    }

    // ON/OFF status
    const isOvenOn = bestAgent.topHeater > 0.01 || bestAgent.bottomHeater > 0.01 || bestAgent.fan > 0.1;
    ctx.textAlign = 'right';
    if (isOvenOn) {
        ctx.fillStyle = '#ef4444';
        ctx.font = 'bold 16px Inter, sans-serif';
        ctx.fillText('OVEN: ON 🔥', w - 10, 25);
    } else {
        ctx.fillStyle = '#94a3b8';
        ctx.font = 'bold 16px Inter, sans-serif';
        ctx.fillText('OVEN: OFF ❄️', w - 10, 25);
    }
}
