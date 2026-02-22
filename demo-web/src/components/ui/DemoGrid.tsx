import React from 'react';
import { DEMOS } from '../../config/demos';
import { DemoCard } from './DemoCard';

export const DemoGrid: React.FC = () => {
    return (
        <section id="demos" className="w-full max-w-7xl mx-auto px-6 py-32 flex flex-col items-center">

            <div className="text-center mb-16 md:mb-24">
                <h2 className="text-3xl md:text-5xl font-light tracking-tight text-foreground/90 mb-4">
                    Laboratório <span className="font-bold">Gran-Prix</span>
                </h2>
                <p className="text-sm md:text-base text-muted-foreground max-w-2xl mx-auto font-medium">
                    Explore os 10 cenários de treinamento. Todas as redes neurais rodam localmente no seu dispositivo via WebAssembly. Sem servidores, sem delay.
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
