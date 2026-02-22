import { useCallback, useRef, useState, useEffect } from 'react';
import { SimulationEngine, SimulationConfig, SimulationState, BaseAgent } from '../core/simulation/SimulationEngine';
import { PerformanceData } from '../types';

export function useSimulation<TAgent extends BaseAgent, TState extends SimulationState<TAgent>, TStats>(
    config: SimulationConfig<TAgent, TState, TStats>,
    initialStateOverrides?: Partial<TState>
) {
    const engineRef = useRef<SimulationEngine<TAgent, TState, TStats> | null>(null);
    const internalState = useRef<TState | null>(null);
    const [stats, setStats] = useState<TStats | null>(null);
    const [performanceHistory, setPerformanceHistory] = useState<PerformanceData[]>([]);
    const [isPlaying, setIsPlaying] = useState(false);
    const [isReady, setIsReady] = useState(false);

    // Initialize engine once
    useEffect(() => {
        const engine = new SimulationEngine(config);
        if (initialStateOverrides) {
            Object.assign(engine.state, initialStateOverrides);
        }
        engine.init().then(() => {
            engineRef.current = engine;
            internalState.current = engine.state;
            setIsReady(true);
        });
    }, [config]); // Re-init only if config changes meaningfully

    const update = useCallback(() => {
        if (!engineRef.current) return;
        
        const prevGen = engineRef.current.state.generation;
        engineRef.current.tick();
        internalState.current = engineRef.current.state;

        // Check for generation change to update performance history
        if (engineRef.current.state.generation > prevGen) {
            const currentStats = engineRef.current.getStats() as any;
            const max = currentStats.bestFitness ?? currentStats.best ?? 0;
            const avg = currentStats.avgFitness ?? (currentStats.best / 2);
            
            setPerformanceHistory(prev => {
                const next = [...prev, { generation: prevGen, avg, max }];
                return next.slice(-60);
            });
        }

        // Batch stats update
        if (engineRef.current.state.frame % 10 === 0) {
            setStats(engineRef.current.getStats());
        }
    }, []);

    const reset = useCallback(() => {
        if (engineRef.current) {
            engineRef.current.reset();
            internalState.current = engineRef.current.state;
            setStats(engineRef.current.getStats());
            setPerformanceHistory([]);
        }
    }, []);

    return {
        engine: engineRef.current,
        internalState,
        stats,
        performanceHistory,
        isPlaying,
        setIsPlaying,
        isReady,
        update,
        reset
    };
}
