import { forwardRef } from 'react';

interface WalkerCanvasProps {
    width: number;
    height: number;
    label?: string;
}

/**
 * Thin wrapper around a <canvas> element for the Bipedal Walker demo.
 *
 * Follows the same forwardRef pattern as FlappyCanvas/GameCanvas so the parent
 * (WalkerDemo) can hold the ref and drive rendering imperatively via
 * requestAnimationFrame — zero re-renders from the canvas itself.
 */
export const WalkerCanvas = forwardRef<HTMLCanvasElement, WalkerCanvasProps>(
    ({ width, height, label = 'Bipedal Walker RL' }, ref) => {
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

WalkerCanvas.displayName = 'WalkerCanvas';
