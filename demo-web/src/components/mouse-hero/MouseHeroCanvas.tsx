import { forwardRef } from 'react';

interface MouseHeroCanvasProps {
    className?: string;
}

/**
 * MouseHeroCanvas
 *
 * A pure rendering surface for the mouse hero demo.
 * All painting is driven externally by MouseHeroDemo via the ref.
 * Covers the full area of its container.
 */
export const MouseHeroCanvas = forwardRef<HTMLCanvasElement, MouseHeroCanvasProps>(
    ({ className = '' }, ref) => {
        return (
            <canvas
                ref={ref}
                className={`absolute inset-0 w-full h-full ${className}`}
                style={{ touchAction: 'none' }}
            />
        );
    },
);

MouseHeroCanvas.displayName = 'MouseHeroCanvas';
