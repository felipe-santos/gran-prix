import { forwardRef } from 'react';
import { VACUUM_WIDTH, VACUUM_HEIGHT } from '../../types';

// We share the Vacuum canvas dimensions to keep layout identical
export const OVEN_CANVAS_WIDTH = VACUUM_WIDTH;
export const OVEN_CANVAS_HEIGHT = VACUUM_HEIGHT;

export const OvenCanvas = forwardRef<HTMLCanvasElement>((_, ref) => {
    return (
        <canvas
            ref={ref}
            width={OVEN_CANVAS_WIDTH}
            height={OVEN_CANVAS_HEIGHT}
            className="w-full max-w-[600px] aspect-[4/3] bg-black rounded-xl shadow-2xl overflow-hidden border border-white/10"
            aria-label="Smart Oven Demo Simulation Canvas"
        />
    );
});
OvenCanvas.displayName = 'OvenCanvas';
