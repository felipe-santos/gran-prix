import { forwardRef } from 'react';
import { VACUUM_WIDTH, VACUUM_HEIGHT } from '../../types';

export const VacuumCanvas = forwardRef<HTMLCanvasElement>((_, ref) => (
    <canvas
        ref={ref}
        width={VACUUM_WIDTH}
        height={VACUUM_HEIGHT}
        className="rounded-2xl border border-border shadow-2xl bg-card"
        style={{ imageRendering: 'auto' }}
    />
));

VacuumCanvas.displayName = 'VacuumCanvas';
