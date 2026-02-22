import React from 'react';
import { Link, Navigate } from 'react-router-dom';
import { ThemeToggle } from '../components/ThemeToggle';
import GoogleTagManager from '../components/GoogleTagManager'; // Keep this as it's not explicitly removed
import { ArrowLeft } from 'lucide-react';
import { DEMOS } from '../config/demos';

// Demos
import { OvenDemo } from '../components/oven';
import { VacuumDemo } from '../components/vacuum';
import { TraderDemo } from '../components/trader';
import { SmartGridDemo } from '../components/smart-grid';
import { DroneDemo } from '../components/drone';
import { PredatorPreyDemo } from '../components/predator-prey';
import { WalkerDemo } from '../components/walker';
import { FlappyDemo } from '../components/flappy';
import { EvolutionDemo } from '../components/evolution';
import { ClassifierWrapper } from '../components/classifier';
import { TurretDemo } from '../components/turret';

const DEMO_COMPONENTS: Record<string, React.FC> = {
    'oven': OvenDemo,
    'vacuum': VacuumDemo,
    'trader': TraderDemo,
    'smart-grid': SmartGridDemo,
    'drone': DroneDemo,
    'predator-prey': PredatorPreyDemo,
    'walker': WalkerDemo,
    'flappy': FlappyDemo,
    'evolution': EvolutionDemo,
    'training': ClassifierWrapper,
    'turret': TurretDemo,
};

interface DemoLayoutProps {
    demoId: string;
}

export const DemoLayout: React.FC<DemoLayoutProps> = ({ demoId }) => {
    const currentDemo = DEMOS.find(d => d.id === demoId);

    if (!currentDemo) {
        return <Navigate to="/" replace />;
    }

    const DemoComponent = DEMO_COMPONENTS[demoId];

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
                    <span className="hidden sm:inline">Back to Laboratory</span>
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

            {/* Demo Content */}
            <main className="w-full flex-1 flex flex-col relative z-10 px-4 md:px-0">
                <div className="w-full max-w-7xl mx-auto pb-24">
                    <DemoComponent />
                </div>
            </main>

            <footer className="pt-24 pb-12 text-muted-foreground text-[8px] uppercase tracking-[0.4em] font-medium w-full text-center">
                Gran-Prix Simulation Protocol • 2026
            </footer>
        </div>
    );
};
