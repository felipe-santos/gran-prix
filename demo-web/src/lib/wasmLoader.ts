import * as wasm from '../wasm/pkg/gran_prix_wasm';

let wasmPromise: Promise<any> | null = null;
let isLoaded = false;

/**
 * Ensures the WASM module is only initialized ONCE.
 * Multiple simultaneous calls will await the same promise.
 */
export async function ensureWasmLoaded() {
    if (isLoaded) return wasm;
    
    if (wasmPromise) {
        return wasmPromise;
    }

    wasmPromise = (async () => {
        try {
            console.log('WASM_LOADER: Initializing Global WASM Instance...');
            await wasm.default();
            wasm.init_panic_hook();
            isLoaded = true;
            console.log('WASM_LOADER: WASM Instance Ready.');
            return wasm;
        } catch (e) {
            console.error('WASM_LOADER: Failed to initialize WASM:', e);
            wasmPromise = null;
            throw e;
        }
    })();

    return wasmPromise;
}

export function isWasmReady() {
    return isLoaded;
}
