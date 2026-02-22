import { forwardRef } from 'react';
import { TURRET_WIDTH, TURRET_HEIGHT } from '../../types';

interface TurretCanvasProps {
    width?: number;
    height?: number;
}

export const TurretCanvas = forwardRef<HTMLCanvasElement, TurretCanvasProps>(
    ({ width = TURRET_WIDTH, height = TURRET_HEIGHT }, ref) => {
        return (
            <div className="relative group overflow-hidden rounded-2xl border border-white/5 bg-black/40 shadow-2xl shadow-cyan-900/10">
                <canvas
                    ref={ref}
                    width={width}
                    height={height}
                    className="block rounded-2xl w-full max-w-full h-auto bg-[var(--canvas-bg)] transition-colors duration-500"
                    style={{
                        boxShadow: 'inset 0 0 50px rgba(0, 229, 255, 0.05)',
                        filter: 'drop-shadow(0 0 10px rgba(0, 229, 255, 0.1))'
                    }}
                />

                {/* Cyberpunk HUD Scanning Line Overlay */}
                <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-2xl mix-blend-screen opacity-20">
                    <div className="w-full h-1 bg-gradient-to-r from-transparent via-[#00e5ff] to-transparent animate-[scan_3s_ease-in-out_infinite]" />
                </div>

                {/* Decorative Frame */}
                <div className="absolute top-2 left-2 w-4 h-4 border-t-2 border-l-2 border-cyan-500/50 rounded-tl-sm pointer-events-none" />
                <div className="absolute top-2 right-2 w-4 h-4 border-t-2 border-r-2 border-cyan-500/50 rounded-tr-sm pointer-events-none" />
                <div className="absolute bottom-2 left-2 w-4 h-4 border-b-2 border-l-2 border-cyan-500/50 rounded-bl-sm pointer-events-none" />
                <div className="absolute bottom-2 right-2 w-4 h-4 border-b-2 border-r-2 border-cyan-500/50 rounded-br-sm pointer-events-none" />
            </div>
        );
    }
);

TurretCanvas.displayName = 'TurretCanvas';
