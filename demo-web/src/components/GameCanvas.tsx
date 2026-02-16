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
                <div className="relative bg-[#0d0d0e] rounded-xl border border-white/[0.05] overflow-hidden">
                    <canvas 
                        ref={ref} 
                        width={width} 
                        height={height}
                        className="block bg-zinc-950/40"
                    />
                </div>
            </div>
        );
    }
);

GameCanvas.displayName = 'GameCanvas';
