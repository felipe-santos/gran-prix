import { useState, useCallback, useRef, useEffect } from 'react';
import * as wasm from '../wasm/pkg/gran_prix_wasm';
import { DRONE_POPULATION_SIZE, DRONE_INPUTS, DRONE_HIDDEN, DRONE_OUTPUTS } from '../types';
import { ensureWasmLoaded } from '../lib/wasmLoader';

/**
 * Manages an isolated WASM Population specifically for the Drone Stabilizer demo.
 */
export function useDroneWasm() {
    const [population, setPopulation] = useState<wasm.Population | null>(null);
    const popRef = useRef<wasm.Population | null>(null);
    const initialized = useRef(false);

    // Keep ref in sync so callbacks never capture stale population
    useEffect(() => {
        popRef.current = population;
        return () => { popRef.current = null; };
    }, [population]);

    const initDroneWasm = useCallback(async () => {
        if (initialized.current) return;
        initialized.current = true;

        try {
            const size = DRONE_POPULATION_SIZE || 200;
            const ins = DRONE_INPUTS || 4;
            const hids = new Uint32Array(DRONE_HIDDEN || [8]);
            const outs = DRONE_OUTPUTS || 2;

            await ensureWasmLoaded();

            const pop = new wasm.Population(size, ins, hids, outs);
            setPopulation(pop);
            console.log(`DRONE: Population Ready (size=${pop.count()})`);
            return pop;
        } catch (e) {
            console.error('DRONE: Initialization failed:', e);
            initialized.current = false;
            throw e;
        }
    }, []);

    const computeDrone = useCallback((inputs: Float32Array): Float32Array | null => {
        const pop = popRef.current;
        if (!pop) return null;
        try {
            return pop.compute_all(inputs);
        } catch (e) {
            console.error(`DRONE: compute_all error:`, e);
            return null;
        }
    }, []);

    const evolveDrone = useCallback((
        fitnessScores: number[],
        mutationRate: number,
        mutationScale: number,
        strategy: wasm.MutationStrategy,
    ) => {
        if (!popRef.current) return;
        try {
            console.log(`DRONE: evolve. fitness size: ${fitnessScores.length}, wasm pop count: ${popRef.current.count()}`);
            popRef.current.evolve(
                Float32Array.from(fitnessScores),
                mutationRate,
                mutationScale,
                strategy,
            );
        } catch (e) {
            console.error('DRONE: evolve error:', e);
            throw e;
        }
    }, []);

    const getDroneBestSnapshot = useCallback(
        (fitnessScores: Float32Array) => {
            if (!popRef.current) return null;
            try {
                return popRef.current.get_best_brain_snapshot(fitnessScores);
            } catch (e) {
                console.error('DRONE: get_best_brain_snapshot error:', e);
                return null;
            }
        },
        [],
    );

    return {
        population,
        initDroneWasm,
        computeDrone,
        evolveDrone,
        getDroneBestSnapshot,
    };
}
