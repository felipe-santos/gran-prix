import { forwardRef } from 'react';

interface PredatorPreyCanvasProps {
    width: number;
    height: number;
    label?: string;
}

/**
 * Thin wrapper around a <canvas> element for the Predator vs Prey demo.
 */
export const PredatorPreyCanvas = forwardRef<HTMLCanvasElement, PredatorPreyCanvasProps>(
    ({ width, height, label = 'Predator vs Prey Co-evolution' }, ref) => {
        return (
            <div className="relative">
                <div className="relative bg-[var(--canvas-bg)] rounded-xl border-8 border-foreground/[0.05] overflow-hidden shadow-2xl shadow-black/40">
                    <canvas
                        ref={ref}
                        width={width}
                        height={height}
                        className="block rounded-lg"
                        aria-label={label}
                    />
                </div>
            </div>
        );
    },
);

PredatorPreyCanvas.displayName = 'PredatorPreyCanvas';
