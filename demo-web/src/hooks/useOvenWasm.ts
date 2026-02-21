import { useState, useCallback, useRef, useEffect } from 'react';
import * as wasm from '../wasm/pkg/gran_prix_wasm';
import { OVEN_POPULATION_SIZE, OVEN_INPUTS, OVEN_HIDDEN, OVEN_OUTPUTS } from '../types';
import { ensureWasmLoaded } from '../lib/wasmLoader';

/**
 * Manages an isolated WASM Population for the Smart Oven demo.
 */
export function useOvenWasm() {
    const [population, setPopulation] = useState<wasm.Population | null>(null);
    const popRef = useRef<wasm.Population | null>(null);
    const initialized = useRef(false);

    useEffect(() => {
        popRef.current = population;
        return () => { popRef.current = null; };
    }, [population]);

    const initOvenWasm = useCallback(async () => {
        if (initialized.current) return;
        initialized.current = true;

        try {
            await ensureWasmLoaded();

            const pop = new wasm.Population(
                OVEN_POPULATION_SIZE,
                OVEN_INPUTS,
                OVEN_HIDDEN,
                OVEN_OUTPUTS,
            );
            setPopulation(pop);
            console.log(`OVEN: Population Ready (size=${pop.count()})`);
            return pop;
        } catch (e) {
            console.error('OVEN: Initialization failed:', e);
            initialized.current = false;
            throw e;
        }
    }, []);

    const computeOven = useCallback((inputs: Float32Array): Float32Array | null => {
        const pop = popRef.current;
        if (!pop) return null;
        try {
            return pop.compute_all(inputs);
        } catch (e) {
            console.error('OVEN: compute_all error:', e);
            return null;
        }
    }, []);

    const evolveOven = useCallback((
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
            console.error('OVEN: evolve error:', e);
            throw e;
        }
    }, []);

    const getOvenBestSnapshot = useCallback(
        (fitnessScores: Float32Array) => {
            if (!popRef.current) return null;
            try {
                return popRef.current.get_best_brain_snapshot(fitnessScores);
            } catch (e) {
                console.error('OVEN: get_best_brain_snapshot error:', e);
                return null;
            }
        },
        [],
    );

    return {
        population,
        initOvenWasm,
        computeOven,
        evolveOven,
        getOvenBestSnapshot,
    };
}
