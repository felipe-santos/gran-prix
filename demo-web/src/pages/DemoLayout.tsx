import React from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { ThemeToggle } from '../components/ThemeToggle';
import GoogleTagManager from '../components/GoogleTagManager';
import { ArrowLeft } from 'lucide-react';
import { DEMOS } from '../config/demos';

export const DemoLayout: React.FC = () => {
    const location = useLocation();

    // Find metadata for the current route to set the top header
    // e.g. from '/demo/oven' -> match.id === 'oven'
    const demoIdMatch = location.pathname.split('/').pop();
    const currentDemo = DEMOS.find(d => d.id === demoIdMatch);

    return (
        <div className="min-h-screen bg-background text-foreground flex flex-col items-center selection:bg-emerald-500/30">
            <GoogleTagManager />
            <ThemeToggle />

            {/* Global Demo Header */}
            <header className="w-full max-w-7xl mx-auto flex items-center justify-between px-6 py-8 md:py-12 border-b border-foreground/[0.03] mb-8">

                <Link
                    to="/"
                    className="flex items-center gap-2 text-muted-foreground hover:text-foreground text-[10px] uppercase font-bold tracking-[0.2em] transition-colors"
                >
                    <ArrowLeft size={16} />
                    <span className="hidden sm:inline">Voltar ao Laboratório</span>
                </Link>

                <div className="flex flex-col items-center md:items-end text-center md:text-right">
                    <h1 className="text-sm md:text-xl font-light tracking-[0.4em] uppercase text-foreground/90">
                        {currentDemo ? currentDemo.title : 'Gran-Prix'}
                    </h1>
                    {currentDemo && (
                        <p className={`text-[8px] md:text-[9px] font-black uppercase tracking-[0.3em] mt-2 bg-gradient-to-r ${currentDemo.color} bg-clip-text text-transparent`}>
                            {currentDemo.subtitle}
                        </p>
                    )}
                </div>

            </header>

            <main className="w-full flex-1 flex flex-col items-center p-4">
                {/* The specific demo component will render here */}
                <Outlet />
            </main>

            <footer className="pt-24 pb-12 text-muted-foreground text-[8px] uppercase tracking-[0.4em] font-medium w-full text-center">
                Gran-Prix Simulation Protocol • 2026
            </footer>
        </div>
    );
};
