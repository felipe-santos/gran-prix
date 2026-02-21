import React from 'react';
import { Play, Pause, RotateCcw } from 'lucide-react';
import { Button } from '../ui/button';

interface PredatorPreyControlsProps {
    isPlaying: boolean;
    onTogglePlay: () => void;
    onReset: () => void;
}

export const PredatorPreyControls: React.FC<PredatorPreyControlsProps> = ({
    isPlaying,
    onTogglePlay,
    onReset,
}) => {
    return (
        <div className="mt-8 flex items-center gap-2 p-2 rounded-xl border border-foreground/[0.05] bg-foreground/[0.01]">
            <Button
                onClick={onTogglePlay}
                className={`h-10 px-10 rounded-lg font-bold transition-all duration-200 flex gap-3 items-center cursor-pointer ${isPlaying
                        ? 'bg-amber-600 hover:bg-amber-700 text-black'
                        : 'bg-foreground text-background hover:bg-foreground/90'
                    }`}
            >
                {isPlaying ? <Pause size={16} /> : <Play size={16} />}
                {isPlaying ? 'PAUSE' : 'START SIMULATION'}
            </Button>

            <div className="h-8 w-px bg-foreground/[0.05]" />

            <Button
                variant="ghost"
                onClick={onReset}
                className="h-10 px-6 rounded-lg text-muted-foreground hover:text-foreground hover:bg-foreground/[0.03] transition-colors flex gap-2 items-center text-xs tracking-widest font-bold cursor-pointer"
            >
                <RotateCcw size={14} />
                RESET
            </Button>
        </div>
    );
};
