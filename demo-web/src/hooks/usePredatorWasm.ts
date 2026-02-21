import { useState, useCallback, useRef, useEffect } from 'react';
import * as wasm from '../wasm/pkg/gran_prix_wasm';
import {
    PREDATOR_POPULATION_SIZE,
    PREDATOR_INPUTS,
    PREDATOR_HIDDEN,
    PREDATOR_OUTPUTS,
} from '../types';
import { ensureWasmLoaded } from '../lib/wasmLoader';

/**
 * Manages an isolated WASM Population specifically for the Predators (Foxes).
 */
export function usePredatorWasm() {
    const [population, setPopulation] = useState<wasm.Population | null>(null);
    const popRef = useRef<wasm.Population | null>(null);
    const initialized = useRef(false);

    useEffect(() => {
        popRef.current = population;
        return () => { popRef.current = null; };
    }, [population]);

    const initPredatorWasm = useCallback(async () => {
        if (initialized.current) return;
        initialized.current = true;

        try {
            console.log('PREDATOR: Requesting WASM Load...');
            await ensureWasmLoaded();

            const pop = new wasm.Population(
                PREDATOR_POPULATION_SIZE,
                PREDATOR_INPUTS,
                PREDATOR_HIDDEN,
                PREDATOR_OUTPUTS,
            );
            setPopulation(pop);
            console.log(
                `PREDATOR: Population Online — size=${pop.count()}, inputs=${PREDATOR_INPUTS}, outputs=${PREDATOR_OUTPUTS}`
            );
            return pop;
        } catch (e) {
            console.error('PREDATOR: Failed to initialize WASM:', e);
            initialized.current = false;
            throw e;
        }
    }, []);

    const computePredator = useCallback((inputs: Float32Array): Float32Array | null => {
        if (!popRef.current) return null;
        try {
            return popRef.current.compute_all(inputs);
        } catch (e) {
            console.error('PREDATOR: compute_all error:', e);
            return null;
        }
    }, []);

    const evolvePredator = useCallback((
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
            console.error('PREDATOR: evolve error:', e);
            throw e;
        }
    }, []);

    const getPredatorBestSnapshot = useCallback(
        (fitnessScores: Float32Array) => {
            if (!popRef.current) return null;
            try {
                return popRef.current.get_best_brain_snapshot(fitnessScores);
            } catch (e) {
                console.error('PREDATOR: get_best_brain_snapshot error:', e);
                return null;
            }
        },
        [],
    );

    return {
        predatorPopulation: population,
        initPredatorWasm,
        computePredator,
        evolvePredator,
        getPredatorBestSnapshot,
    };
}
