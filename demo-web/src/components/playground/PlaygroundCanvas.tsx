import React, { useRef, useEffect, MouseEvent } from 'react';

export interface DataPoint {
    x: number;
    y: number;
    label: number;
}

interface PlaygroundCanvasProps {
    points: DataPoint[];
    onCanvasClick: (x: number, y: number) => void;
    decisionBoundary: number[]; // Flat array of size resolution * resolution
    resolution: number;
    width?: number;
    height?: number;
}

export const PlaygroundCanvas: React.FC<PlaygroundCanvasProps> = ({
    points,
    onCanvasClick,
    decisionBoundary,
    resolution,
    width = 600,
    height = 600
}) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    const handleClick = (e: MouseEvent<HTMLCanvasElement>) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const normX = (x / rect.width) * 2 - 1;
        const normY = (y / rect.height) * 2 - 1;

        onCanvasClick(normX, normY);
    };

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // 1. Draw Decision Boundary
        if (decisionBoundary.length === resolution * resolution) {
            const cellW = width / resolution;
            const cellH = height / resolution;

            for (let j = 0; j < resolution; j++) {
                for (let i = 0; i < resolution; i++) {
                    const prob = decisionBoundary[j * resolution + i];
                    const r = Math.round(255 * prob);
                    const b = Math.round(255 * (1 - prob));
                    const g = Math.round(100 * prob + 100 * (1 - prob));

                    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
                    ctx.fillRect(i * cellW, j * cellH, cellW, cellH);
                }
            }
        } else {
            ctx.fillStyle = '#0f172a';
            ctx.fillRect(0, 0, width, height);
        }

        // 2. Draw Points with Glow
        points.forEach(pt => {
            const cx = ((pt.x + 1) / 2) * width;
            const cy = ((pt.y + 1) / 2) * height;

            const gradient = ctx.createRadialGradient(cx, cy, 2, cx, cy, 10);
            gradient.addColorStop(0, pt.label === 1 ? 'rgba(249, 115, 22, 0.8)' : 'rgba(59, 130, 246, 0.8)');
            gradient.addColorStop(1, 'rgba(0,0,0,0)');

            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(cx, cy, 12, 0, Math.PI * 2);
            ctx.fill();

            ctx.beginPath();
            ctx.arc(cx, cy, 5, 0, Math.PI * 2);
            ctx.fillStyle = pt.label === 1 ? '#fb923c' : '#60a5fa';
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();
        });

    }, [points, decisionBoundary, resolution, width, height]);

    return (
        <div className="relative overflow-hidden rounded-2xl border border-white/10 shadow-2xl cursor-crosshair">
            <canvas
                ref={canvasRef}
                width={width}
                height={height}
                onClick={handleClick}
                className="block w-full max-w-[600px] aspect-square bg-slate-900"
            />
            {/* Overlay Grid */}
            <div className="absolute inset-0 pointer-events-none opacity-10" style={{
                backgroundImage: 'linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)',
                backgroundSize: '30px 30px'
            }} />
        </div>
    );
};
