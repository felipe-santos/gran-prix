import { useState, useCallback, useRef, useEffect } from 'react';
import * as wasm from '../wasm/pkg/gran_prix_wasm';
import { VACUUM_POPULATION_SIZE, VACUUM_INPUTS, VACUUM_HIDDEN, VACUUM_OUTPUTS } from '../types';
import { ensureWasmLoaded } from '../lib/wasmLoader';

/**
 * Manages an isolated WASM Population for the Smart Vacuum demo.
 */
export function useVacuumWasm() {
    const [population, setPopulation] = useState<wasm.Population | null>(null);
    const popRef = useRef<wasm.Population | null>(null);
    const initialized = useRef(false);

    useEffect(() => {
        popRef.current = population;
        return () => { popRef.current = null; };
    }, [population]);

    const initVacuumWasm = useCallback(async () => {
        if (initialized.current) return;
        initialized.current = true;

        try {
            await ensureWasmLoaded();

            const pop = new wasm.Population(
                VACUUM_POPULATION_SIZE,
                VACUUM_INPUTS,
                VACUUM_HIDDEN,
                VACUUM_OUTPUTS,
            );
            setPopulation(pop);
            console.log(`VACUUM: Population Ready (size=${pop.count()})`);
            return pop;
        } catch (e) {
            console.error('VACUUM: Initialization failed:', e);
            initialized.current = false;
            throw e;
        }
    }, []);

    const computeVacuum = useCallback((inputs: Float32Array): Float32Array | null => {
        const pop = popRef.current;
        if (!pop) return null;
        try {
            return pop.compute_all(inputs);
        } catch (e) {
            console.error('VACUUM: compute_all error:', e);
            return null;
        }
    }, []);

    const evolveVacuum = useCallback((
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
            console.error('VACUUM: evolve error:', e);
            throw e;
        }
    }, []);

    const getVacuumBestSnapshot = useCallback(
        (fitnessScores: Float32Array) => {
            if (!popRef.current) return null;
            try {
                return popRef.current.get_best_brain_snapshot(fitnessScores);
            } catch (e) {
                console.error('VACUUM: get_best_brain_snapshot error:', e);
                return null;
            }
        },
        [],
    );

    return {
        population,
        initVacuumWasm,
        computeVacuum,
        evolveVacuum,
        getVacuumBestSnapshot,
    };
}
