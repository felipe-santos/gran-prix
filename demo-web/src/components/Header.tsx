import React from 'react';

export const Header: React.FC = () => {
    return (
        <header className="w-full flex flex-col items-center mb-16 border-b border-foreground/[0.03] pb-8">
            <h1 className="text-2xl font-light tracking-[0.6em] uppercase text-foreground/80">
                Gran-Prix
            </h1>
            <p className="text-muted-foreground font-medium tracking-[0.3em] uppercase text-[8px] mt-4">
                Synthetic Neural Evolution
            </p>
        </header>
    );
};
