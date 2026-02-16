import { useState, useCallback, useRef, useEffect } from 'react';
import * as wasm from '../wasm/pkg/gran_prix_wasm';
import { POPULATION_SIZE } from '../types';

export function useWasmPopulation() {
    const [population, setPopulation] = useState<wasm.Population | null>(null);
    const popRef = useRef<wasm.Population | null>(null);
    const initialized = useRef(false);

    useEffect(() => {
        popRef.current = population;
        return () => { popRef.current = null; };
    }, [population]);

    const initWasm = useCallback(async () => {
        if (initialized.current) return;
        initialized.current = true;

        try {
            console.log("PRIX: Initializing WASM...");
            await wasm.default();
            wasm.init_panic_hook();
            
            const pop = new wasm.Population(POPULATION_SIZE);
            setPopulation(pop);
            console.log(`Gran-Prix Population Online! Size: ${pop.count()}`);
            return pop;
        } catch (e) {
            console.error("Failed to load WASM:", e);
            throw e;
        }
    }, []);

    const evolve = useCallback((fitnessScores: number[], mutationRate: number, mutationScale: number, mutationStrategy: wasm.MutationStrategy) => {
        if (!popRef.current) return;
        try {
            popRef.current.evolve(Float32Array.from(fitnessScores), mutationRate, mutationScale, mutationStrategy);
        } catch (e) {
            console.error("Evolution failed:", e);
            throw e;
        }
    }, []);

    const computeAll = useCallback((inputs: Float32Array) => {
        if (!popRef.current) return null;
        try {
            return popRef.current.compute_all(inputs);
        } catch (e) {
            console.error("WASM Compute Error:", e);
            throw e;
        }
    }, []);

    const getBestBrainSnapshot = useCallback((fitnessScores: Float32Array) => {
        if (!popRef.current) return null;
        try {
            return popRef.current.get_best_brain_snapshot(fitnessScores);
        } catch (e) {
            console.error("Failed to get brain snapshot:", e);
            return null;
        }
    }, []);

    const setGlobalKernel = useCallback((k1: number, k2: number, k3: number) => {
        if (!popRef.current) return;
        try {
            popRef.current.set_global_kernel(k1, k2, k3);
        } catch (e) {
            console.error("Failed to set kernel:", e);
        }
    }, []);

    return {
        population,
        popRef,
        initWasm,
        evolve,
        computeAll,
        getBestBrainSnapshot,
        setGlobalKernel
    };
}
