import { forwardRef } from 'react';

interface ClassifierCanvasProps {
    onCanvasClick?: (e: React.MouseEvent<HTMLCanvasElement>) => void;
}

export const ClassifierCanvas = forwardRef<HTMLCanvasElement, ClassifierCanvasProps>(({ onCanvasClick }, ref) => {
    return (
        <div className="relative group">
            <canvas
                ref={ref}
                width={600}
                height={450}
                onClick={onCanvasClick}
                className="w-full max-w-[600px] aspect-[4/3] bg-black rounded-xl shadow-2xl overflow-hidden border border-white/10 cursor-crosshair"
                aria-label="Backprop Lab Simulation Canvas"
            />
            <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none flex items-end justify-center pb-8">
                <span className="text-[10px] bg-black/80 text-white/50 px-4 py-2 rounded-full backdrop-blur-md border border-white/10 uppercase tracking-[0.2em] font-black shadow-2xl">
                    Click to add points (Left: Green, Shift: Rose)
                </span>
            </div>
        </div>
    );
});

ClassifierCanvas.displayName = 'ClassifierCanvas';
