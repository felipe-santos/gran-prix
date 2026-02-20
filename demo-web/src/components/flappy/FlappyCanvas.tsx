import { forwardRef } from 'react';

interface FlappyCanvasProps {
    width: number;
    height: number;
    label?: string;
}

/**
 * Thin wrapper around a <canvas> element for the Flappy Bird demo.
 *
 * Follows the same forwardRef pattern as GameCanvas so the parent
 * (FlappyDemo) can hold the ref and drive rendering imperatively via
 * requestAnimationFrame — zero re-renders from the canvas itself.
 */
export const FlappyCanvas = forwardRef<HTMLCanvasElement, FlappyCanvasProps>(
    ({ width, height, label = 'Flappy Bird RL' }, ref) => {
        return (
            <div className="relative">
                {/* Outer chrome — matches the GameCanvas aesthetic */}
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

FlappyCanvas.displayName = 'FlappyCanvas';
