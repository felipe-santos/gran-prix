import React from 'react';
import { Link } from 'react-router-dom';
import { DemoMetadata } from '../../config/demos';
import { ChevronRight } from 'lucide-react';

interface DemoCardProps {
    demo: DemoMetadata;
}

export const DemoCard: React.FC<DemoCardProps> = ({ demo }) => {
    return (
        <Link
            to={`/demo/${demo.id}`}
            className="group relative flex flex-col h-full bg-card/40 border border-white/5 backdrop-blur-md rounded-2xl p-6 transition-all duration-500 hover:scale-[1.02] hover:-translate-y-1 hover:border-white/10 hover:shadow-2xl overflow-hidden"
        >
            {/* Subtle background glow effect using the card's theme color */}
            <div className={`absolute -inset-px opacity-0 group-hover:opacity-10 transition-opacity duration-500 pointer-events-none rounded-2xl bg-gradient-to-br ${demo.color}`} />

            <div className="flex items-start justify-between mb-6 relative z-10">
                <div className="p-3 bg-white/5 border border-white/10 rounded-xl">
                    <demo.icon size={24} className="text-foreground/90" />
                </div>
                <div className={`p-2 rounded-full bg-white/5 opacity-0 group-hover:opacity-100 transition-all transform translate-x-4 group-hover:translate-x-0`}>
                    <ChevronRight size={16} className={`text-foreground/80`} />
                </div>
            </div>

            <div className="flex-1 relative z-10">
                <h3 className="text-lg font-bold text-foreground mb-1 tracking-tight">
                    {demo.title}
                </h3>
                <h4 className={`text-[10px] font-black uppercase tracking-widest mb-4 bg-gradient-to-r ${demo.color} bg-clip-text text-transparent`}>
                    {demo.subtitle}
                </h4>
                <p className="text-sm text-muted-foreground leading-relaxed mb-6 font-medium">
                    {demo.description}
                </p>
            </div>

            <div className="flex flex-wrap gap-2 mt-auto relative z-10">
                {demo.tags.map(tag => (
                    <span
                        key={tag}
                        className="px-2.5 py-1 rounded-full bg-white/5 border border-white/5 text-[9px] font-mono text-muted-foreground uppercase tracking-wider"
                    >
                        {tag}
                    </span>
                ))}
            </div>
        </Link>
    );
};
