import { useState, useCallback, useRef, useEffect } from 'react';
import * as wasm from '../wasm/pkg/gran_prix_wasm';
import { FLAPPY_POPULATION_SIZE, FLAPPY_INPUTS } from '../types';

/**
 * Manages an isolated WASM Population specifically for the Flappy Bird demo.
 *
 * Kept separate from `useWasmPopulation` (used by Cars) because:
 * - Different network input size: 4 (Flappy) vs 5 (Cars)
 * - Different fitness semantics
 * - Shared instance would corrupt state across demos
 *
 * Mirror's the same ref-based pattern from `useWasmPopulation` to ensure
 * compute callbacks never go stale due to closure captures.
 */
export function useFlappyWasm() {
    const [population, setPopulation] = useState<wasm.Population | null>(null);
    const popRef = useRef<wasm.Population | null>(null);
    const initialized = useRef(false);

    // Keep ref in sync so callbacks never capture stale population
    useEffect(() => {
        popRef.current = population;
        return () => { popRef.current = null; };
    }, [population]);

    const initFlappyWasm = useCallback(async () => {
        if (initialized.current) return;
        initialized.current = true;

        try {
            console.log('FLAPPY: Initializing WASM Population...');
            // The wasm module is already initialized by the Cars demo if it ran first,
            // but calling default() is idempotent — safe to call again.
            await wasm.default();
            wasm.init_panic_hook();

            const pop = new wasm.Population(FLAPPY_POPULATION_SIZE, FLAPPY_INPUTS, 8, 1);
            setPopulation(pop);
            console.log(`FLAPPY: Population Online — size=${pop.count()}, inputs=${FLAPPY_INPUTS}`);
            return pop;
        } catch (e) {
            console.error('FLAPPY: Failed to initialize WASM:', e);
            throw e;
        }
    }, []);

    /**
     * Run forward-pass for all alive birds.
     * inputs: Float32Array of shape [N * FLAPPY_INPUTS]
     * Returns Float32Array of shape [N] — output per bird (>0.5 = jump)
     */
    const computeFlappy = useCallback((inputs: Float32Array): Float32Array | null => {
        if (!popRef.current) return null;
        try {
            return popRef.current.compute_all(inputs);
        } catch (e) {
            console.error('FLAPPY: compute_all error:', e);
            return null;
        }
    }, []);

    /**
     * Run evolution step with provided fitness scores.
     * Must be called once per generation when all birds are dead.
     */
    const evolveFlappy = useCallback((
        fitnessScores: number[],
        mutationRate: number,
        mutationScale: number,
        strategy: wasm.MutationStrategy,
    ) => {
        if (!popRef.current) return;
        try {
            popRef.current.evolve(
                Float32Array.from(fitnessScores),
                mutationRate,
                mutationScale,
                strategy,
            );
        } catch (e) {
            console.error('FLAPPY: evolve error:', e);
            throw e;
        }
    }, []);

    /**
     * Returns the weight/bias snapshot of the fittest brain for visualization.
     */
    const getFlappyBestSnapshot = useCallback(
        (fitnessScores: Float32Array) => {
            if (!popRef.current) return null;
            try {
                return popRef.current.get_best_brain_snapshot(fitnessScores);
            } catch (e) {
                console.error('FLAPPY: get_best_brain_snapshot error:', e);
                return null;
            }
        },
        [],
    );

    return {
        population,
        popRef,
        initFlappyWasm,
        computeFlappy,
        evolveFlappy,
        getFlappyBestSnapshot,
    };
}
