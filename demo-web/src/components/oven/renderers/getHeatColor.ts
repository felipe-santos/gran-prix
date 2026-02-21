/**
 * Converts temperature to heat color visualization
 * @param temp - Temperature in Celsius
 * @param ambientTemp - Ambient room temperature
 * @param maxTemp - Maximum oven temperature
 * @returns HSL color string representing temperature
 */
export function getHeatColor(temp: number, ambientTemp: number = 25, maxTemp: number = 300): string {
    // Normalizes temp from Ambient (25) to Max (300) into a color
    const t = Math.max(0, Math.min(1, (temp - ambientTemp) / (maxTemp - ambientTemp)));
    // Room temp -> Dark blue/gray, Medium -> Orange/Red, High -> Yellow/White
    if (t < 0.2) return `hsl(210, 40%, ${15 + t * 50}%)`;
    if (t < 0.6) return `hsl(${(1 - (t - 0.2) / 0.4) * 60 + 10}, 80%, ${30 + t * 30}%)`;
    return `hsl(10, 90%, ${50 + (t - 0.6) / 0.4 * 50}%)`;
}
