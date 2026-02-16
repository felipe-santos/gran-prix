import { forwardRef } from 'react';

interface GameCanvasProps {
    width: number;
    height: number;
}

export const GameCanvas = forwardRef<HTMLCanvasElement, GameCanvasProps>(
    ({ width, height }, ref) => {
        return (
            <div className="relative">
                {/* Canvas Container */}
                <div className="relative bg-[var(--canvas-bg)] rounded-xl border-8 border-foreground/[0.05] overflow-hidden">
                    <canvas 
                        ref={ref} 
                        width={width} 
                        height={height}
                        className="block rounded-lg"
                    />
                </div>
            </div>
        );
    }
);

GameCanvas.displayName = 'GameCanvas';
