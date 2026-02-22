import React, { useEffect, useState } from 'react';
import { MousePredictionPhase } from '../../types';
import { ChevronDown } from 'lucide-react';

interface MouseHeroOverlayProps {
    phase: MousePredictionPhase;
    onExplore: () => void;
}

export const MouseHeroOverlay: React.FC<MouseHeroOverlayProps> = ({ phase, onExplore }) => {
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
        if (phase === 'reveal') {
            const timer = setTimeout(() => setIsVisible(true), 100);
            return () => clearTimeout(timer);
        } else {
            setIsVisible(false);
        }
    }, [phase]);

    return (
        <div
            className={`absolute inset-0 z-20 flex flex-col items-center justify-center pointer-events-none transition-all duration-[2000ms] ease-out transform ${isVisible ? 'opacity-100 scale-100 blur-none' : 'opacity-0 scale-110 blur-xl'
                }`}
        >
            {/* Radial glow directly behind the text to ensure legibility against intense canvas paths */}
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,var(--color-background)_0%,transparent_50%)] opacity-80" />

            <div className="max-w-4xl text-center px-6 pointer-events-none relative z-10 flex flex-col items-center">
                <p className="text-2xl md:text-4xl lg:text-5xl font-light text-foreground/90 tracking-tight leading-tight">
                    Você acabou de rodar uma rede neural em <br className="hidden md:block" />
                    <span className="font-semibold text-foreground">Rust</span> compilado para <span className="font-semibold bg-gradient-to-r from-[#00e5ff] to-[#10b981] bg-clip-text text-transparent drop-shadow-[0_0_15px_rgba(0,229,255,0.4)]">WebAssembly</span>.
                </p>

                <p className="text-sm md:text-lg text-muted-foreground mt-6 max-w-2xl font-medium tracking-wide">
                    Zero APIs. Nenhum dado saiu do seu browser. Aprendizado ao vivo, inferência em milissegundos, segurança absoluta.
                </p>

                <div className="mt-12 overflow-hidden">
                    <span className={`block text-xs md:text-sm uppercase font-black tracking-[0.4em] bg-gradient-to-r from-[#ff00ff] to-[#00e5ff] bg-clip-text text-transparent drop-shadow-[0_0_20px_rgba(255,0,255,0.3)] transition-all duration-[1500ms] delay-700 ${isVisible ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0'}`}>
                        Isso é Gran-Prix.
                    </span>
                </div>
            </div>

            <div className="absolute bottom-12 flex flex-col items-center gap-3">
                <button
                    onClick={onExplore}
                    className={`flex flex-col items-center gap-2 px-6 py-4 rounded-full border border-white/5 bg-white/5 backdrop-blur-md text-[10px] uppercase tracking-[0.2em] font-bold text-foreground hover:bg-white/10 hover:border-white/20 hover:scale-105 transition-all pointer-events-auto shadow-2xl shadow-emerald-500/10 ${isVisible ? 'animate-bounce delay-1000' : ''}`}
                >
                    <span className="bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">Explorar a Engenharia</span>
                    <ChevronDown size={16} className="text-cyan-400" />
                </button>
            </div>
        </div>
    );
};
