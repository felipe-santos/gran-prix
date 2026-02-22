import React from 'react';
import { BookOpen, Lightbulb } from 'lucide-react';
import { Preset } from './PlaygroundPresets';

interface PlaygroundExplanationProps {
    preset: Preset | null;
}

export const PlaygroundExplanation: React.FC<PlaygroundExplanationProps> = ({ preset }) => {
    if (!preset) {
        return (
            <div className="bg-card/40 backdrop-blur-sm border border-white/5 rounded-2xl p-6 flex flex-col gap-4">
                <div className="flex items-center gap-2 text-cyan-400">
                    <Lightbulb size={20} />
                    <h3 className="font-semibold text-lg">Dica do Pesquisador</h3>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">
                    Clique no canvas para adicionar pontos de dados. Experimente criar padrões que não podem ser divididos por uma linha reta para ver como a rede neural reage!
                </p>
            </div>
        );
    }

    return (
        <div className="bg-card/40 backdrop-blur-sm border border-white/5 rounded-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-purple-400">
                    <BookOpen size={20} />
                    <h3 className="font-semibold text-lg">{preset.name}</h3>
                </div>
                <span className="text-[10px] font-mono bg-purple-500/10 text-purple-400 border border-purple-500/20 px-2 py-1 rounded">
                    PRESET ATIVO
                </span>
            </div>

            <div className="space-y-4">
                <div>
                    <h4 className="text-xs font-mono text-white/40 uppercase tracking-widest mb-2">O que é?</h4>
                    <p className="text-sm text-foreground/80 leading-relaxed">
                        {preset.description}
                    </p>
                </div>

                <div className="bg-white/5 p-4 rounded-xl border border-white/5">
                    <h4 className="text-xs font-mono text-purple-400 uppercase tracking-widest mb-2 flex items-center gap-2">
                        <Lightbulb size={12} /> Desafio Didático
                    </h4>
                    <p className="text-sm text-muted-foreground leading-relaxed italic">
                        {preset.explanation}
                    </p>
                </div>

                <div className="flex items-center gap-4 text-[10px] font-mono text-cyan-400/60">
                    <div className="flex items-center gap-1">
                        <div className="w-2 h-2 rounded-full bg-cyan-500" /> Recomendações:
                    </div>
                    <span>Arquitetura: [{preset.recommendedArch.length === 0 ? "Nenhuma" : preset.recommendedArch.join(', ')}]</span>
                </div>
            </div>
        </div>
    );
};
