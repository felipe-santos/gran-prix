import { useState, useCallback, useRef, useEffect } from 'react';
import * as wasm from '../wasm/pkg/gran_prix_wasm';
import {
    WALKER_POPULATION_SIZE,
    WALKER_INPUTS,
    WALKER_HIDDEN,
    WALKER_OUTPUTS,
} from '../types';

/**
 * Manages an isolated WASM Population specifically for the Bipedal Walker demo.
 *
 * Kept separate from `useWasmPopulation` (Cars) and `useFlappyWasm` (Flappy) because:
 * - Different network shape: 10 inputs → 12 hidden → 4 outputs
 * - Different fitness semantics (distance-based continuous reward)
 * - Shared instance would corrupt state across demos
 *
 * Mirrors the same ref-based pattern from `useFlappyWasm` to ensure
 * compute callbacks never go stale due to closure captures.
 */
export function useWalkerWasm() {
    const [population, setPopulation] = useState<wasm.Population | null>(null);
    const popRef = useRef<wasm.Population | null>(null);
    const initialized = useRef(false);

    // Keep ref in sync so callbacks never capture stale population
    useEffect(() => {
        popRef.current = population;
        return () => { popRef.current = null; };
    }, [population]);

    const initWalkerWasm = useCallback(async () => {
        if (initialized.current) return;
        initialized.current = true;

        try {
            console.log('WALKER: Initializing WASM Population...');
            await wasm.default();
            wasm.init_panic_hook();

            const pop = new wasm.Population(
                WALKER_POPULATION_SIZE,
                WALKER_INPUTS,
                WALKER_HIDDEN,
                WALKER_OUTPUTS,
            );
            setPopulation(pop);
            console.log(
                `WALKER: Population Online — size=${pop.count()}, ` +
                `inputs=${WALKER_INPUTS}, hidden=${WALKER_HIDDEN}, outputs=${WALKER_OUTPUTS}`,
            );
            return pop;
        } catch (e) {
            console.error('WALKER: Failed to initialize WASM:', e);
            throw e;
        }
    }, []);

    /**
     * Run forward-pass for all alive walkers.
     * inputs: Float32Array of shape [N * WALKER_INPUTS]
     * Returns Float32Array of shape [N * WALKER_OUTPUTS]
     */
    const computeWalker = useCallback((inputs: Float32Array): Float32Array | null => {
        if (!popRef.current) return null;
        try {
            return popRef.current.compute_all(inputs);
        } catch (e) {
            console.error('WALKER: compute_all error:', e);
            return null;
        }
    }, []);

    /**
     * Run evolution step with provided fitness scores.
     * Must be called once per generation when all walkers are dead or time limit hit.
     */
    const evolveWalker = useCallback((
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
            console.error('WALKER: evolve error:', e);
            throw e;
        }
    }, []);

    /**
     * Returns the weight/bias snapshot of the fittest brain for visualization.
     */
    const getWalkerBestSnapshot = useCallback(
        (fitnessScores: Float32Array) => {
            if (!popRef.current) return null;
            try {
                return popRef.current.get_best_brain_snapshot(fitnessScores);
            } catch (e) {
                console.error('WALKER: get_best_brain_snapshot error:', e);
                return null;
            }
        },
        [],
    );

    return {
        population,
        popRef,
        initWalkerWasm,
        computeWalker,
        evolveWalker,
        getWalkerBestSnapshot,
    };
}
