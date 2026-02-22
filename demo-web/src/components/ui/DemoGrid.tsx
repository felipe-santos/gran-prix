import React from 'react';
import { DEMOS } from '../../config/demos';
import { DemoCard } from './DemoCard';

export const DemoGrid: React.FC = () => {
    return (
        <section id="demos" className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-24 sm:py-32 flex flex-col items-center">

            <div className="text-center mb-16 md:mb-24 px-4">
                <h2 className="text-3xl sm:text-4xl md:text-5xl font-light tracking-tight text-foreground/90 mb-4 sm:mb-6">
                    Gran-Prix <span className="font-bold">Laboratory</span>
                </h2>
                <p className="text-sm sm:text-base text-muted-foreground max-w-2xl mx-auto font-medium leading-relaxed">
                    Explore 10 distinct mathematical scenarios. All neural networks run entirely client-side on your device via WebAssembly. Zero servers, zero latency.
                </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 w-full">
                {DEMOS.map(demo => (
                    <DemoCard key={demo.id} demo={demo} />
                ))}
            </div>

        </section>
    );
};
