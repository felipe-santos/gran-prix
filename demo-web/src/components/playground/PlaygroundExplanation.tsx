import React from 'react';
import { BookOpen, Lightbulb } from 'lucide-react';
import { Preset } from './PlaygroundPresets';

interface PlaygroundExplanationProps {
    preset: Preset | null;
}

export const PlaygroundExplanation: React.FC<PlaygroundExplanationProps> = ({ preset }) => {
    return (
        <div className="bg-card/50 border border-border rounded-2xl overflow-hidden backdrop-blur-md flex flex-col shadow-xl">
            <div className="p-4 border-b border-border bg-card/80">
                <h3 className="text-sm font-bold text-foreground uppercase tracking-tighter flex items-center gap-2">
                    <BookOpen size={14} className="text-cyan-500" />
                    {preset ? preset.name : 'Researcher Intelligence'}
                </h3>
                <p className="text-[9px] text-muted-foreground font-mono mt-0.5 uppercase">
                    {preset ? 'Active Protocol Analysis' : 'Observation Mode'}
                </p>
            </div>

            <div className="p-5 space-y-5">
                {!preset ? (
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 text-muted-foreground">
                            <Lightbulb size={12} />
                            <label className="text-[9px] font-bold uppercase tracking-widest">Didactic Status</label>
                        </div>
                        <p className="text-[10px] text-muted-foreground leading-relaxed italic">
                            Select a scenario preset to see internal analysis. You can also manually add points to challenge the neural network's convergence.
                        </p>
                    </div>
                ) : (
                    <>
                        <div className="space-y-2">
                            <label className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground block">
                                Pattern Topology
                            </label>
                            <p className="text-[11px] text-foreground/80 leading-relaxed font-medium">
                                {preset.description}
                            </p>
                        </div>

                        <div className="space-y-2 pt-2 border-t border-border/50">
                            <label className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground block">
                                Mathematical Insight
                            </label>
                            <div className="bg-cyan-500/5 border border-cyan-500/10 p-3 rounded-lg">
                                <p className="text-[10px] text-cyan-500/80 leading-relaxed italic font-medium">
                                    {preset.explanation}
                                </p>
                            </div>
                        </div>

                        <div className="space-y-2 pt-2 border-t border-border/50">
                            <label className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground block">
                                Convergence Strategy
                            </label>
                            <div className="flex items-center justify-between">
                                <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">Recommended Depth</span>
                                <span className="text-xs font-mono font-bold text-cyan-500">
                                    {preset.recommendedArch.length === 0 ? 'LINEAR' : `[${preset.recommendedArch.join(', ')}]`}
                                </span>
                            </div>
                        </div>
                    </>
                )}
            </div>

            <div className="p-3 bg-muted/50 border-t border-border text-[7px] text-muted-foreground font-mono text-center tracking-widest uppercase">
                INTELLIGENCE_LAYER • PRIX_DIDACTIC
            </div>
        </div>
    );
};
