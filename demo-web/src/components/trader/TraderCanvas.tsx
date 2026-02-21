import { forwardRef } from 'react';
import { TRADER_WIDTH, TRADER_HEIGHT } from '../../types';

export const TraderCanvas = forwardRef<HTMLCanvasElement>((_, ref) => (
    <canvas
        ref={ref}
        width={TRADER_WIDTH}
        height={TRADER_HEIGHT}
        className="rounded-2xl border border-border shadow-2xl bg-card"
        style={{ imageRendering: 'auto' }}
    />
));

TraderCanvas.displayName = 'TraderCanvas';
