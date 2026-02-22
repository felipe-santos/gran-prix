import React from 'react';
import { MouseHeroDemo } from '../components/mouse-hero';
import { DemoGrid } from '../components/ui/DemoGrid';
import { ThemeToggle } from '../components/ThemeToggle';
import GoogleTagManager from '../components/GoogleTagManager';

export const LandingPage: React.FC = () => {
    return (
        <div className="min-h-screen bg-background text-foreground flex flex-col items-center selection:bg-emerald-500/30">
            <GoogleTagManager />
            <ThemeToggle />

            {/* 100vh Hero Section */}
            <div className="w-full min-h-screen relative flex items-center justify-center p-4 md:p-12 overflow-hidden">
                <MouseHeroDemo onExplore={() => {
                    const gridElement = document.getElementById('demos');
                    if (gridElement) {
                        gridElement.scrollIntoView({ behavior: 'smooth' });
                    }
                }} />
            </div>

            {/* The Rest of the Content */}
            <DemoGrid />

            <footer className="pt-24 pb-12 text-muted-foreground text-[8px] uppercase tracking-[0.4em] font-medium w-full text-center border-t border-white/5">
                Gran-Prix Simulation Protocol • 2026
            </footer>
        </div>
    );
};
