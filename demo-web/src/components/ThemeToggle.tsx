import React, { useEffect, useState } from 'react';
import { Sun, Moon } from 'lucide-react';
import { Button } from './ui/button';

export const ThemeToggle: React.FC = () => {
    const [theme, setTheme] = useState<'light' | 'dark'>(() => {
        if (typeof window !== 'undefined') {
            return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
        }
        return 'light';
    });

    useEffect(() => {
        if (theme === 'dark') {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
    }, [theme]);

    const toggleTheme = () => {
        setTheme(prev => prev === 'light' ? 'dark' : 'light');
    };

    return (
        <Button
            variant="ghost"
            onClick={toggleTheme}
            className="fixed top-8 right-8 w-10 h-10 rounded-lg p-0 flex items-center justify-center border border-white/[0.05] bg-white/[0.01] hover:bg-white/[0.03] transition-colors"
            title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
        >
            {theme === 'light' ? <Moon size={16} className="text-zinc-600" /> : <Sun size={16} className="text-zinc-400" />}
        </Button>
    );
};
