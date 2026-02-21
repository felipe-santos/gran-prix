import { useState, useCallback, useRef, useEffect } from 'react';
import * as wasm from '../wasm/pkg/gran_prix_wasm';
import { GRID_POPULATION_SIZE, GRID_INPUTS, GRID_HIDDEN, GRID_OUTPUTS } from '../types';
import { ensureWasmLoaded } from '../lib/wasmLoader';

/**
 * Manages an isolated WASM Population for the Smart Grid demo.
 */
export function useSmartGridWasm() {
    const [population, setPopulation] = useState<wasm.Population | null>(null);
    const popRef = useRef<wasm.Population | null>(null);
    const initialized = useRef(false);

    useEffect(() => {
        popRef.current = population;
        return () => { popRef.current = null; };
    }, [population]);

    const initGridWasm = useCallback(async () => {
        if (initialized.current) return;
        initialized.current = true;

        try {
            await ensureWasmLoaded();

            const pop = new wasm.Population(
                GRID_POPULATION_SIZE,
                GRID_INPUTS,
                GRID_HIDDEN,
                GRID_OUTPUTS,
            );
            setPopulation(pop);
            console.log(`GRID: Population Ready (size=${pop.count()})`);
            return pop;
        } catch (e) {
            console.error('GRID: Initialization failed:', e);
            initialized.current = false;
            throw e;
        }
    }, []);

    const computeGrid = useCallback((inputs: Float32Array): Float32Array | null => {
        const pop = popRef.current;
        if (!pop) return null;
        try {
            return pop.compute_all(inputs);
        } catch (e) {
            console.error('GRID: compute_all error:', e);
            return null;
        }
    }, []);

    const evolveGrid = useCallback((
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
            console.error('GRID: evolve error:', e);
            throw e;
        }
    }, []);

    const getGridBestSnapshot = useCallback(
        (fitnessScores: Float32Array) => {
            if (!popRef.current) return null;
            try {
                return popRef.current.get_best_brain_snapshot(fitnessScores);
            } catch (e) {
                console.error('GRID: get_best_brain_snapshot error:', e);
                return null;
            }
        },
        [],
    );

    return {
        population,
        initGridWasm,
        computeGrid,
        evolveGrid,
        getGridBestSnapshot,
    };
}
