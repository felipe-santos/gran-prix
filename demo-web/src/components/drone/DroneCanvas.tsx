import { forwardRef } from 'react';


interface DroneCanvasProps {
    width: number;
    height: number;
}

/**
 * Pure presentation component for the canvas.
 * Imperatively driven by DroneDemo via ref to avoid React render cycles per frame.
 */
export const DroneCanvas = forwardRef<HTMLCanvasElement, DroneCanvasProps>(
    ({ width, height }, ref) => {
        return (
            <div className="relative rounded-2xl overflow-hidden border border-border bg-card/50 shadow-2xl backdrop-blur-sm">
                {/* Hardware accelerated layer */}
                <canvas
                    ref={ref}
                    width={width}
                    height={height}
                    className="block"
                    style={{
                        width: `${width}px`,
                        height: `${height}px`,
                        imageRendering: 'pixelated', // Crisp edges
                    }}
                />
            </div>
        );
    }
);

DroneCanvas.displayName = 'DroneCanvas';
