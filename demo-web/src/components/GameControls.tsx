import React from 'react';
import { Button } from './ui/button';
import { Play, Pause, RotateCcw } from 'lucide-react';

interface GameControlsProps {
    isPlaying: boolean;
    onTogglePlay: () => void;
    onReset: () => void;
    isRestarting?: boolean;
}

export const GameControls: React.FC<GameControlsProps> = ({ 
    isPlaying, 
    onTogglePlay, 
    onReset, 
    isRestarting 
}) => {
    return (
        <div className="mt-8 flex items-center gap-4 p-4 rounded-xl border border-white/[0.05] bg-white/[0.01]">
            <Button 
                onClick={onTogglePlay} 
                className={`h-12 px-10 rounded-lg font-bold transition-all duration-200 flex gap-3 items-center ${
                    isPlaying 
                        ? 'bg-amber-600 hover:bg-amber-700 text-black' 
                        : 'bg-white hover:bg-zinc-200 text-black'
                }`}
            >
                {isPlaying ? <Pause size={16} /> : <Play size={16} />}
                {isRestarting ? 'RESTARTING' : (isPlaying ? 'PAUSE' : 'START SIMULATION')}
            </Button>

            <div className="h-8 w-px bg-white/[0.05]"></div>

            <Button 
                variant="ghost" 
                onClick={onReset}
                className="h-12 px-6 rounded-lg text-zinc-500 hover:text-white hover:bg-white/[0.03] transition-colors flex gap-2 items-center text-xs tracking-widest font-bold"
            >
                <RotateCcw size={14} />
                RESET
            </Button>
        </div>
    );
};
