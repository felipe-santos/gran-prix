import { forwardRef } from 'react';
import { GRID_WIDTH, GRID_HEIGHT } from '../../types';

export const SmartGridCanvas = forwardRef<HTMLCanvasElement>((_, ref) => (
    <canvas
        ref={ref}
        width={GRID_WIDTH}
        height={GRID_HEIGHT}
        className="rounded-2xl border border-border shadow-2xl bg-card"
        style={{ imageRendering: 'auto' }}
    />
));

SmartGridCanvas.displayName = 'SmartGridCanvas';
