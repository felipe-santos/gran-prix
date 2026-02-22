import { useState, useCallback, useRef } from 'react';
import * as wasm from '../wasm/pkg/gran_prix_wasm';
import { ensureWasmLoaded } from '../lib/wasmLoader';

/**
 * useMouseTrainerWasm
 *
 * Manages two isolated WASM Trainer instances for the Mouse Hero demo:
 *   - trainerX: learns to predict the next horizontal velocity (dx)
 *   - trainerY: learns to predict the next vertical velocity (dy)
 *
 * Both trainers receive (current_dx, current_dy) as input and output
 * the forecasted delta for the X or Y axis respectively.
 *
 * Follows the same isolation pattern as useFlappyWasm.ts.
 */

const HIDDEN_SIZE = 12;
const LEARNING_RATE = 0.05;

export interface MousePrediction {
    predDx: number;
    predDy: number;
}

export function useMouseTrainerWasm() {
    const [isReady, setIsReady] = useState(false);
    const trainerXRef = useRef<wasm.Trainer | null>(null);
    const trainerYRef = useRef<wasm.Trainer | null>(null);
    const initialized = useRef(false);

    /**
     * Initialize both Trainer instances. Safe to call multiple times.
     * Idempotent due to `initialized` guard.
     */
    const initTrainers = useCallback(async () => {
        if (initialized.current) return;
        initialized.current = true;

        try {
            await ensureWasmLoaded();

            trainerXRef.current = new wasm.Trainer(2, new Uint32Array([HIDDEN_SIZE]));
            trainerYRef.current = new wasm.Trainer(2, new Uint32Array([HIDDEN_SIZE]));

            setIsReady(true);
        } catch (err) {
            console.error('[MouseHero] Failed to initialize WASM Trainers:', err);
            initialized.current = false;
        }
    }, []);

    /**
     * Train both networks with one sample.
     * @param dx      Current normalized horizontal velocity  [-1, 1]
     * @param dy      Current normalized vertical velocity     [-1, 1]
     * @param nextDx  Target future dx                        [-1, 1] → mapped to [0,1] for BCE
     * @param nextDy  Target future dy                        [-1, 1] → mapped to [0,1] for BCE
     * @returns { lossX, lossY } — training losses for debug display
     */
    const trainStep = useCallback(
        (dx: number, dy: number, nextDx: number, nextDy: number): { lossX: number; lossY: number } => {
            if (!trainerXRef.current || !trainerYRef.current) return { lossX: 0, lossY: 0 };

            // Map [-1,1] → [0,1] so BCE loss is valid
            const targetX = (nextDx + 1) / 2;
            const targetY = (nextDy + 1) / 2;

            let lossX = 0;
            let lossY = 0;

            try {
                const resultX = trainerXRef.current.train_step(new Float32Array([dx, dy]), targetX, LEARNING_RATE);
                lossX = resultX;
            } catch (e) {
                console.warn('[MouseHero] trainerX train_step error:', e);
            }

            try {
                const resultY = trainerYRef.current.train_step(new Float32Array([dx, dy]), targetY, LEARNING_RATE);
                lossY = resultY;
            } catch (e) {
                console.warn('[MouseHero] trainerY train_step error:', e);
            }

            return { lossX, lossY };
        },
        [],
    );

    /**
     * Run inference through both trainers.
     * @param dx  Current normalized horizontal velocity [-1, 1]
     * @param dy  Current normalized vertical velocity   [-1, 1]
     * @returns Predicted (predDx, predDy) in [-1, 1], or null if not ready.
     */
    const predict = useCallback((dx: number, dy: number): MousePrediction | null => {
        if (!trainerXRef.current || !trainerYRef.current) return null;

        try {
            // Output is sigmoid [0,1] → map back to [-1,1]
            const rawX = trainerXRef.current.predict(new Float32Array([dx, dy]));
            const rawY = trainerYRef.current.predict(new Float32Array([dx, dy]));

            return {
                predDx: rawX * 2 - 1,
                predDy: rawY * 2 - 1,
            };
        } catch (e) {
            console.warn('[MouseHero] predict error:', e);
            return null;
        }
    }, []);

    return {
        isReady,
        initTrainers,
        trainStep,
        predict,
    };
}
