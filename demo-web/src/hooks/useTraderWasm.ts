import { useState, useCallback, useRef, useEffect } from 'react';
import * as wasm from '../wasm/pkg/gran_prix_wasm';
import { TRADER_POPULATION_SIZE, TRADER_INPUTS, TRADER_HIDDEN, TRADER_OUTPUTS } from '../types';
import { ensureWasmLoaded } from '../lib/wasmLoader';

/**
 * Manages an isolated WASM Population for the AI Trader demo.
 */
export function useTraderWasm() {
    const [population, setPopulation] = useState<wasm.Population | null>(null);
    const popRef = useRef<wasm.Population | null>(null);
    const initialized = useRef(false);

    useEffect(() => {
        popRef.current = population;
        return () => { popRef.current = null; };
    }, [population]);

    const initTraderWasm = useCallback(async () => {
        if (initialized.current) return;
        initialized.current = true;

        try {
            await ensureWasmLoaded();

            const pop = new wasm.Population(
                TRADER_POPULATION_SIZE,
                TRADER_INPUTS,
                new Uint32Array(TRADER_HIDDEN),
                TRADER_OUTPUTS,
            );
            setPopulation(pop);
            console.log(`TRADER: Population Ready (size=${pop.count()})`);
            return pop;
        } catch (e) {
            console.error('TRADER: Initialization failed:', e);
            initialized.current = false;
            throw e;
        }
    }, []);

    const computeTrader = useCallback((inputs: Float32Array): Float32Array | null => {
        const pop = popRef.current;
        if (!pop) return null;
        try {
            return pop.compute_all(inputs);
        } catch (e) {
            console.error('TRADER: compute_all error:', e);
            return null;
        }
    }, []);

    const evolveTrader = useCallback((
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
            console.error('TRADER: evolve error:', e);
            throw e;
        }
    }, []);

    const getTraderBestSnapshot = useCallback(
        (fitnessScores: Float32Array) => {
            if (!popRef.current) return null;
            try {
                return popRef.current.get_best_brain_snapshot(fitnessScores);
            } catch (e) {
                console.error('TRADER: get_best_brain_snapshot error:', e);
                return null;
            }
        },
        [],
    );

    return {
        population,
        initTraderWasm,
        computeTrader,
        evolveTrader,
        getTraderBestSnapshot,
    };
}
