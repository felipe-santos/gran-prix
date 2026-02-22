import { FeatureType, getFeatureLabel } from './features';

export function generateCCode(weights: Float32Array, hiddenLayers: number[], activeFeatures: FeatureType[]): string {
    const inputDim = activeFeatures.length;
    const outputDim = 1;

    let currentIdx = 0;
    let prevSize = inputDim;
    const layers: { w: number[], b: number[], in: number, out: number }[] = [];

    // Extract layers
    hiddenLayers.forEach((hSize) => {
        const wCount = prevSize * hSize;
        const bCount = hSize;
        layers.push({
            w: Array.from(weights.slice(currentIdx, currentIdx + wCount)),
            b: Array.from(weights.slice(currentIdx + wCount, currentIdx + wCount + bCount)),
            in: prevSize,
            out: hSize
        });
        currentIdx += wCount + bCount;
        prevSize = hSize;
    });

    // Output layer
    const wOutCount = prevSize * outputDim;
    const bOutCount = outputDim;
    layers.push({
        w: Array.from(weights.slice(currentIdx, currentIdx + wOutCount)),
        b: Array.from(weights.slice(currentIdx + wOutCount, currentIdx + wOutCount + bOutCount)),
        in: prevSize,
        out: outputDim
    });

    const timestamp = new Date().toISOString();

    return `/**
 * PRIX_PROTOCOL - Neural Inference Header
 * Generated on: ${timestamp}
 * 
 * Features:
 * - Zero dependencies (Pure C99)
 * - Tanh activation for hidden layers
 * - Sigmoid activation for final classification
 */

#ifndef PRIX_NEURAL_CORE_H
#define PRIX_NEURAL_CORE_H

#include <math.h>

/* --- Input Feature Mapping ---
${activeFeatures.map((f, i) => ` * [${i}] ${getFeatureLabel(f)}`).join('\n')}
 */

/* --- Model Topology --- */
#define INPUT_DIM ${inputDim}
#define HIDDEN_LAYERS_COUNT ${hiddenLayers.length}
#define OUTPUT_DIM ${outputDim}

/* --- Activation Functions --- */
static float prix_tanh(float x) {
    return (float)tanh(x);
}

static float prix_sigmoid(float x) {
    return 1.0f / (1.0f + expf(-x));
}

/* --- Model Parameters --- */
${layers.map((l, i) => `
// Layer ${i + 1} (${l.in} -> ${l.out})
static const float WEIGHTS_${i}[${l.w.length}] = { ${l.w.map(w => w.toFixed(6)).join(', ')} };
static const float BIASES_${i}[${l.b.length}] = { ${l.b.map(b => b.toFixed(6)).join(', ')} };`).join('\n')}

/**
 * Perform inference on an input vector of size INPUT_DIM.
 * Returns a probability [0..1] for the classification.
 */
float prix_predict(const float* input) {
    // Current input/buffer pointer
    float buffer_a[${Math.max(...hiddenLayers, inputDim, 16)}];
    float buffer_b[${Math.max(...hiddenLayers, inputDim, 16)}];
    
    // Copy input to initial buffer
    for(int i = 0; i < INPUT_DIM; i++) buffer_a[i] = input[i];
    
    float* in_ptr = buffer_a;
    float* out_ptr = buffer_b;
    int current_in_size = INPUT_DIM;

    ${layers.map((l, i) => `
    // Process Layer ${i + 1}
    for (int next = 0; next < ${l.out}; next++) {
        float sum = BIASES_${i}[next];
        for (int prev = 0; prev < ${l.in}; prev++) {
            sum += in_ptr[prev] * WEIGHTS_${i}[prev * ${l.out} + next];
        }
        out_ptr[next] = ${(i === layers.length - 1) ? 'sum' : 'prix_tanh(sum)'};
    }
    // Swap buffers
    { float* tmp = in_ptr; in_ptr = out_ptr; out_ptr = tmp; }
    `).join('')}

    // Final result (after sigmoid)
    return prix_sigmoid(in_ptr[0]);
}

#endif // PRIX_NEURAL_CORE_H
`;
}
