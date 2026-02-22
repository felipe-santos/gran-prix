import React, { useEffect, useRef, useState, useCallback } from 'react';
import { MousePredictionPhase, MousePoint } from '../../types';
import { useMouseTrainerWasm } from '../../hooks/useMouseTrainerWasm';
import { MouseHeroCanvas } from './MouseHeroCanvas';
import { MouseHeroStats } from './MouseHeroStats';
import { MouseHeroOverlay } from './MouseHeroOverlay';

const HISTORY_LENGTH = 45; // slightly shorter for tighter curves
const TRAINING_TIME_MS = 5000;
const REVEAL_DELAY_MS = 2000;

class Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
    maxLife: number;
    color: string;
    size: number;

    constructor(x: number, y: number, vx: number, vy: number, color: string, isSpark: boolean) {
        this.x = x;
        this.y = y;
        this.vx = vx + (Math.random() - 0.5) * (isSpark ? 2 : 0.5);
        this.vy = vy + (Math.random() - 0.5) * (isSpark ? 2 : 0.5);
        this.maxLife = isSpark ? 40 + Math.random() * 30 : 60 + Math.random() * 20;
        this.life = this.maxLife;
        this.color = color;
        this.size = isSpark ? Math.random() * 2 + 1 : Math.random() * 3 + 2;
    }

    update() {
        this.x += this.vx;
        this.y += this.vy;
        this.life--;
        this.vx *= 0.95; // friction
        this.vy *= 0.95;
    }

    draw(ctx: CanvasRenderingContext2D) {
        if (this.life <= 0) return;
        const alpha = (this.life / this.maxLife);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = this.color;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size * alpha, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1.0;
    }
}

export const MouseHeroDemo: React.FC<{ onExplore: () => void }> = ({ onExplore }) => {
    const { isReady, initTrainers, trainStep, predict } = useMouseTrainerWasm();

    const [phase, setPhase] = useState<MousePredictionPhase>('training');
    const [samples, setSamples] = useState(0);
    const [losses, setLosses] = useState({ x: 0, y: 0 });

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const historyRef = useRef<MousePoint[]>([]);
    const phaseRef = useRef<MousePredictionPhase>('training');
    const particlesRef = useRef<Particle[]>([]);

    // For smooth mouse interpolation
    const lastMouseRef = useRef({ x: 0, y: 0 });
    const targetMouseRef = useRef({ x: 0, y: 0 });

    // Resize observer for canvas
    useEffect(() => {
        const resize = () => {
            if (canvasRef.current && canvasRef.current.parentElement) {
                canvasRef.current.width = canvasRef.current.parentElement.clientWidth;
                canvasRef.current.height = canvasRef.current.parentElement.clientHeight;
            }
        };
        window.addEventListener('resize', resize);
        resize();
        return () => window.removeEventListener('resize', resize);
    }, []);

    // Initialize WASM
    useEffect(() => {
        initTrainers();
    }, [initTrainers]);

    // Keep phase ref in sync for event listeners
    useEffect(() => {
        phaseRef.current = phase;
    }, [phase]);

    // Phase timer
    useEffect(() => {
        if (!isReady) return;

        const timer1 = setTimeout(() => {
            setPhase('predicting');
        }, TRAINING_TIME_MS);

        const timer2 = setTimeout(() => {
            setPhase('reveal');
        }, TRAINING_TIME_MS + REVEAL_DELAY_MS);

        return () => {
            clearTimeout(timer1);
            clearTimeout(timer2);
        };
    }, [isReady]);

    // Mouse movement collection & training
    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        if (!isReady) return;

        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;

        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const now = performance.now();

        targetMouseRef.current = { x, y };

        const history = historyRef.current;
        history.push({ x, y, t: now });
        if (history.length > HISTORY_LENGTH) {
            history.shift();
        }

        // Spawn movement sparks
        if (Math.random() > 0.5 && history.length > 2) {
            const p1 = history[history.length - 2];
            const p2 = history[history.length - 1];
            const vx = (p1.x - p2.x) * 0.1; // Opposite direction of movement
            const vy = (p1.y - p2.y) * 0.1;
            particlesRef.current.push(new Particle(x, y, vx, vy, '#10b981', true)); // emerald
        }

        // We need at least 3 points to compute velocities (v1, v2)
        if (history.length >= 3) {
            const p0 = history[history.length - 3];
            const p1 = history[history.length - 2];
            const p2 = history[history.length - 1];

            const dt1 = Math.max(1, p1.t - p0.t);
            const dt2 = Math.max(1, p2.t - p1.t);

            const MAX_SPEED = 5; // px/ms
            let dx1 = (p1.x - p0.x) / dt1 / MAX_SPEED;
            let dy1 = (p1.y - p0.y) / dt1 / MAX_SPEED;
            let dx2 = (p2.x - p1.x) / dt2 / MAX_SPEED;
            let dy2 = (p2.y - p1.y) / dt2 / MAX_SPEED;

            dx1 = Math.max(-1, Math.min(1, dx1));
            dy1 = Math.max(-1, Math.min(1, dy1));
            dx2 = Math.max(-1, Math.min(1, dx2));
            dy2 = Math.max(-1, Math.min(1, dy2));

            const { lossX, lossY } = trainStep(dx1, dy1, dx2, dy2);

            setSamples(s => s + 1);
            setLosses({ x: lossX, y: lossY });
        }
    }, [isReady, trainStep]);

    // Render loop
    useEffect(() => {
        let rafId: number;
        let frameCount = 0;

        const render = () => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            const w = canvas.width;
            const h = canvas.height;
            const history = historyRef.current;
            frameCount++;

            // Smooth mouse interpolation
            lastMouseRef.current.x += (targetMouseRef.current.x - lastMouseRef.current.x) * 0.3;
            lastMouseRef.current.y += (targetMouseRef.current.y - lastMouseRef.current.y) * 0.3;

            // 1. Clear frame with high motion blur (low alpha)
            ctx.globalCompositeOperation = 'source-over';
            const trailColor = getComputedStyle(document.documentElement).getPropertyValue('--canvas-bg').trim() || '#0d0d0e';

            // Extract rgb from hex/rgb string if possible, or fallback manually
            // For extreme glow, the background fade needs to be very dark but clean
            ctx.fillStyle = trailColor === '#0d0d0e' ? 'rgba(13, 13, 14, 0.2)' : 'rgba(248, 248, 249, 0.2)';
            ctx.fillRect(0, 0, w, h);

            // 2. Draw Subtle Grid
            const gridStyle = getComputedStyle(document.documentElement).getPropertyValue('--canvas-grid').trim() || 'rgba(255, 255, 255, 0.02)';
            ctx.strokeStyle = gridStyle;
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let x = 0; x < w; x += 40) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
            for (let y = 0; y < h; y += 40) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
            ctx.stroke();

            if (history.length < 2) {
                rafId = requestAnimationFrame(render);
                return;
            }

            // --- PREMIUM EFFECTS START HERE ---
            ctx.globalCompositeOperation = 'lighter'; // Additive blending for neon glow

            // 3. Draw Fluid Mouse Trail (Bezier Curve)
            if (history.length > 2) {
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';

                // Base glowing line
                ctx.beginPath();
                ctx.moveTo(history[0].x, history[0].y);

                for (let i = 1; i < history.length - 1; i++) {
                    const xc = (history[i].x + history[i + 1].x) / 2;
                    const yc = (history[i].y + history[i + 1].y) / 2;
                    ctx.quadraticCurveTo(history[i].x, history[i].y, xc, yc);
                }
                // Connect to the actual current interpolated mouse position
                ctx.lineTo(lastMouseRef.current.x, lastMouseRef.current.y);

                ctx.lineWidth = 6;
                ctx.strokeStyle = 'rgba(16, 185, 129, 0.15)'; // Thick soft emerald glow
                ctx.stroke();

                ctx.lineWidth = 2;
                ctx.strokeStyle = 'rgba(52, 211, 153, 0.8)';  // Thin bright green core
                ctx.stroke();
            }

            // 4. Update and Draw Particles
            particlesRef.current.forEach(p => p.update());
            particlesRef.current = particlesRef.current.filter(p => p.life > 0);
            particlesRef.current.forEach(p => p.draw(ctx));

            const currentMouse = lastMouseRef.current;

            // 5. Training Visuals (Cyberpunk Aperture Rings)
            if (phaseRef.current === 'training') {
                const time = performance.now() * 0.002;
                const r1 = 15 + Math.sin(time * 2) * 5;
                const r2 = 25 + Math.cos(time * 1.5) * 8;

                // Inner ring
                ctx.beginPath();
                ctx.arc(currentMouse.x, currentMouse.y, r1, time, time + Math.PI * 1.5);
                ctx.strokeStyle = 'rgba(245, 158, 11, 0.8)'; // Amber
                ctx.lineWidth = 2;
                ctx.stroke();

                // Outer dashed ring
                ctx.beginPath();
                ctx.setLineDash([4, 6]);
                ctx.arc(currentMouse.x, currentMouse.y, r2, -time, -time + Math.PI * 1.8);
                ctx.strokeStyle = 'rgba(16, 185, 129, 0.6)'; // Emerald
                ctx.lineWidth = 1;
                ctx.stroke();
                ctx.setLineDash([]); // reset
            }

            // 6. Prediction Logic & Visuals (Stream of Particles)
            if ((phaseRef.current === 'predicting' || phaseRef.current === 'reveal') && history.length >= 2) {
                const p1 = history[history.length - 2];
                const p2 = history[history.length - 1];
                const dt = Math.max(1, p2.t - p1.t);
                const MAX_SPEED = 5;

                let dx = (p2.x - p1.x) / dt / MAX_SPEED;
                let dy = (p2.y - p1.y) / dt / MAX_SPEED;
                dx = Math.max(-1, Math.min(1, dx));
                dy = Math.max(-1, Math.min(1, dy));

                const prediction = predict(dx, dy);

                if (prediction) {
                    const { predDx, predDy } = prediction;

                    // Extrapolate distance
                    const visualScale = Math.max(200, dt * MAX_SPEED * 30); // Project far ahead
                    const futureX = currentMouse.x + (predDx * visualScale);
                    const futureY = currentMouse.y + (predDy * visualScale);

                    // Draw the core glowing prediction line
                    ctx.beginPath();
                    const grad = ctx.createLinearGradient(currentMouse.x, currentMouse.y, futureX, futureY);
                    grad.addColorStop(0, 'rgba(0, 229, 255, 0)');      // Transparent at cursor
                    grad.addColorStop(0.5, 'rgba(0, 229, 255, 0.6)');  // Intense Cyan
                    grad.addColorStop(1, 'rgba(255, 0, 255, 0.8)');    // Neon Magenta tip

                    ctx.strokeStyle = grad;
                    ctx.lineWidth = 3;
                    ctx.moveTo(currentMouse.x, currentMouse.y);
                    ctx.lineTo(futureX, futureY);
                    ctx.stroke();

                    // Endpoint Target Reticle
                    ctx.beginPath();
                    ctx.arc(futureX, futureY, 6, 0, Math.PI * 2);
                    ctx.strokeStyle = '#ff00ff';
                    ctx.lineWidth = 2;
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.arc(futureX, futureY, 2, 0, Math.PI * 2);
                    ctx.fillStyle = '#fff';
                    ctx.fill();

                    // Spawn Prediction Stream Particles (rapid fire)
                    if (frameCount % 2 === 0) {
                        const px = predDx * MAX_SPEED * 4;
                        const py = predDy * MAX_SPEED * 4;
                        // Shoot particles from cursor towards target
                        particlesRef.current.push(new Particle(currentMouse.x, currentMouse.y, px, py, '#00e5ff', false));
                    }
                }
            }

            ctx.globalCompositeOperation = 'source-over'; // reset for next frame
            rafId = requestAnimationFrame(render);
        };

        rafId = requestAnimationFrame(render);
        return () => cancelAnimationFrame(rafId);
    }, [predict]);

    return (
        <div
            className="w-full h-[calc(100vh-8rem)] relative rounded-2xl overflow-hidden cursor-crosshair border border-white/5 bg-background shadow-2xl shadow-emerald-500/5 group"
            onMouseMove={handleMouseMove}
            onMouseLeave={() => { historyRef.current = []; }}
        >
            {/* Soft background radial vignette */}
            <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_center,transparent_0%,rgba(0,0,0,0.4)_100%)] z-0 dark:block hidden" />

            <MouseHeroCanvas ref={canvasRef} />
            <MouseHeroStats
                phase={phase}
                samples={samples}
                lossX={losses.x}
                lossY={losses.y}
            />
            <MouseHeroOverlay
                phase={phase}
                onExplore={onExplore}
            />
        </div>
    );
};
