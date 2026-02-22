/**
 * Feature Engineering Utility
 * Maps raw 2D input (x, y) to an expanded feature vector.
 */

export type FeatureType = 'x' | 'y' | 'x2' | 'y2' | 'xy' | 'sin_x' | 'sin_y';

export const ALL_FEATURES: FeatureType[] = ['x', 'y', 'x2', 'y2', 'xy', 'sin_x', 'sin_y'];

export function expandFeatures(x: number, y: number, activeFeatures: FeatureType[]): Float32Array {
    const result = new Float32Array(activeFeatures.length);
    activeFeatures.forEach((feat, i) => {
        switch (feat) {
            case 'x': result[i] = x; break;
            case 'y': result[i] = y; break;
            case 'x2': result[i] = x * x; break;
            case 'y2': result[i] = y * y; break;
            case 'xy': result[i] = x * y; break;
            case 'sin_x': result[i] = Math.sin(x); break;
            case 'sin_y': result[i] = Math.sin(y); break;
        }
    });
    return result;
}

export function getFeatureLabel(feat: FeatureType): string {
    switch (feat) {
        case 'x': return 'X₁';
        case 'y': return 'X₂';
        case 'x2': return 'X₁²';
        case 'y2': return 'X₂²';
        case 'xy': return 'X₁X₂';
        case 'sin_x': return 'sin(X₁)';
        case 'sin_y': return 'sin(X₂)';
        default: return feat;
    }
}
