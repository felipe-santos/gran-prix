import { useState, useCallback, useRef, useEffect } from 'react';
import * as wasm from '../wasm/pkg/gran_prix_wasm';
import {
    PREY_POPULATION_SIZE,
    PREY_INPUTS,
    PREY_HIDDEN,
    PREY_OUTPUTS,
} from '../types';

/**
 * Manages an isolated WASM Population specifically for the Prey (Rabbits).
 */
export function usePreyWasm() {
    const [population, setPopulation] = useState<wasm.Population | null>(null);
    const popRef = useRef<wasm.Population | null>(null);
    const initialized = useRef(false);

    useEffect(() => {
        popRef.current = population;
        return () => { popRef.current = null; };
    }, [population]);

    const initPreyWasm = useCallback(async () => {
        if (initialized.current) return;
        initialized.current = true;

        try {
            console.log('PREY: Initializing WASM Population...');
            await wasm.default();
            wasm.init_panic_hook();

            const pop = new wasm.Population(
                PREY_POPULATION_SIZE,
                PREY_INPUTS,
                PREY_HIDDEN,
                PREY_OUTPUTS,
            );
            setPopulation(pop);
            console.log(
                `PREY: Population Online — size=${pop.count()}, inputs=${PREY_INPUTS}, outputs=${PREY_OUTPUTS}`
            );
            return pop;
        } catch (e) {
            console.error('PREY: Failed to initialize WASM:', e);
            throw e;
        }
    }, []);

    const computePrey = useCallback((inputs: Float32Array): Float32Array | null => {
        if (!popRef.current) return null;
        try {
            return popRef.current.compute_all(inputs);
        } catch (e) {
            console.error('PREY: compute_all error:', e);
            return null;
        }
    }, []);

    const evolvePrey = useCallback((
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
            console.error('PREY: evolve error:', e);
            throw e;
        }
    }, []);

    const getPreyBestSnapshot = useCallback(
        (fitnessScores: Float32Array) => {
            if (!popRef.current) return null;
            try {
                return popRef.current.get_best_brain_snapshot(fitnessScores);
            } catch (e) {
                console.error('PREY: get_best_brain_snapshot error:', e);
                return null;
            }
        },
        [],
    );

    return {
        preyPopulation: population,
        initPreyWasm,
        computePrey,
        evolvePrey,
        getPreyBestSnapshot,
    };
}
