/**
 * Network Templates
 *
 * Pre-configured neural network architectures for common use cases.
 * These templates help users get started quickly with proven architectures.
 *
 * @module components/playground/v2/Templates/templates
 */

import {
    NetworkTemplate,
    LayerType,
    ActivationType,
} from '@/types/network-builder';

// ─── Template Definitions ───────────────────────────────────────────────────

export const NETWORK_TEMPLATES: NetworkTemplate[] = [
    // ─── Simple Classifier ──────────────────────────────────────────────────
    {
        id: 'simple-classifier',
        name: 'Simple Classifier',
        description: 'Basic 2-layer feedforward network for binary classification',
        category: 'classification',
        difficulty: 1,
        useCases: ['XOR problem', 'Simple patterns', 'Linear separable data'],
        graph: {
            layers: [
                {
                    id: 'input-simple',
                    type: LayerType.INPUT,
                    position: { x: 80, y: 250 },
                    params: { inputSize: 2 },
                    label: 'Input',
                },
                {
                    id: 'linear-1-simple',
                    type: LayerType.LINEAR,
                    position: { x: 320, y: 200 },
                    params: { inputSize: 2, outputSize: 8, useBias: true },
                },
                {
                    id: 'activation-1-simple',
                    type: LayerType.ACTIVATION,
                    position: { x: 320, y: 300 },
                    params: { activationType: ActivationType.TANH },
                },
                {
                    id: 'linear-2-simple',
                    type: LayerType.LINEAR,
                    position: { x: 560, y: 200 },
                    params: { inputSize: 8, outputSize: 4, useBias: true },
                },
                {
                    id: 'activation-2-simple',
                    type: LayerType.ACTIVATION,
                    position: { x: 560, y: 300 },
                    params: { activationType: ActivationType.TANH },
                },
                {
                    id: 'output-simple',
                    type: LayerType.OUTPUT,
                    position: { x: 800, y: 250 },
                    params: { outputSize: 1 },
                    label: 'Output',
                },
            ],
            connections: [
                { id: 'conn-1-simple', from: 'input-simple', to: 'linear-1-simple' },
                { id: 'conn-2-simple', from: 'linear-1-simple', to: 'activation-1-simple' },
                { id: 'conn-3-simple', from: 'activation-1-simple', to: 'linear-2-simple' },
                { id: 'conn-4-simple', from: 'linear-2-simple', to: 'activation-2-simple' },
                { id: 'conn-5-simple', from: 'activation-2-simple', to: 'output-simple' },
            ],
            metadata: {
                name: 'Simple Classifier',
                description: '2-layer feedforward network',
                created: Date.now(),
                modified: Date.now(),
                tags: ['beginner', 'classification'],
            },
        },
    },

    // ─── Deep Network ───────────────────────────────────────────────────────
    {
        id: 'deep-network',
        name: 'Deep Network',
        description: '4-layer deep network for complex non-linear patterns',
        category: 'classification',
        difficulty: 3,
        useCases: ['Spiral data', 'Donut patterns', 'Complex boundaries'],
        graph: {
            layers: [
                {
                    id: 'input-deep',
                    type: LayerType.INPUT,
                    position: { x: 50, y: 300 },
                    params: { inputSize: 2 },
                    label: 'Input',
                },
                {
                    id: 'linear-1-deep',
                    type: LayerType.LINEAR,
                    position: { x: 220, y: 150 },
                    params: { inputSize: 2, outputSize: 16, useBias: true },
                },
                {
                    id: 'activation-1-deep',
                    type: LayerType.ACTIVATION,
                    position: { x: 220, y: 250 },
                    params: { activationType: ActivationType.RELU },
                },
                {
                    id: 'linear-2-deep',
                    type: LayerType.LINEAR,
                    position: { x: 390, y: 150 },
                    params: { inputSize: 16, outputSize: 16, useBias: true },
                },
                {
                    id: 'activation-2-deep',
                    type: LayerType.ACTIVATION,
                    position: { x: 390, y: 250 },
                    params: { activationType: ActivationType.RELU },
                },
                {
                    id: 'linear-3-deep',
                    type: LayerType.LINEAR,
                    position: { x: 560, y: 150 },
                    params: { inputSize: 16, outputSize: 8, useBias: true },
                },
                {
                    id: 'activation-3-deep',
                    type: LayerType.ACTIVATION,
                    position: { x: 560, y: 250 },
                    params: { activationType: ActivationType.RELU },
                },
                {
                    id: 'linear-4-deep',
                    type: LayerType.LINEAR,
                    position: { x: 730, y: 150 },
                    params: { inputSize: 8, outputSize: 4, useBias: true },
                },
                {
                    id: 'activation-4-deep',
                    type: LayerType.ACTIVATION,
                    position: { x: 730, y: 250 },
                    params: { activationType: ActivationType.TANH },
                },
                {
                    id: 'output-deep',
                    type: LayerType.OUTPUT,
                    position: { x: 900, y: 300 },
                    params: { outputSize: 1 },
                    label: 'Output',
                },
            ],
            connections: [
                { id: 'conn-1-deep', from: 'input-deep', to: 'linear-1-deep' },
                { id: 'conn-2-deep', from: 'linear-1-deep', to: 'activation-1-deep' },
                { id: 'conn-3-deep', from: 'activation-1-deep', to: 'linear-2-deep' },
                { id: 'conn-4-deep', from: 'linear-2-deep', to: 'activation-2-deep' },
                { id: 'conn-5-deep', from: 'activation-2-deep', to: 'linear-3-deep' },
                { id: 'conn-6-deep', from: 'linear-3-deep', to: 'activation-3-deep' },
                { id: 'conn-7-deep', from: 'activation-3-deep', to: 'linear-4-deep' },
                { id: 'conn-8-deep', from: 'linear-4-deep', to: 'activation-4-deep' },
                { id: 'conn-9-deep', from: 'activation-4-deep', to: 'output-deep' },
            ],
            metadata: {
                name: 'Deep Network',
                description: '4-layer deep architecture with ReLU activations',
                created: Date.now(),
                modified: Date.now(),
                tags: ['advanced', 'deep-learning', 'classification'],
            },
        },
    },

    // ─── XOR Minimal ────────────────────────────────────────────────────────
    {
        id: 'xor-minimal',
        name: 'XOR Minimal',
        description: 'Minimal architecture to solve the classic XOR problem',
        category: 'classification',
        difficulty: 1,
        useCases: ['XOR problem', 'Learning basics', 'Simple non-linearity'],
        graph: {
            layers: [
                {
                    id: 'input-xor',
                    type: LayerType.INPUT,
                    position: { x: 120, y: 250 },
                    params: { inputSize: 2 },
                    label: 'Input (2)',
                },
                {
                    id: 'linear-xor',
                    type: LayerType.LINEAR,
                    position: { x: 400, y: 200 },
                    params: { inputSize: 2, outputSize: 4, useBias: true },
                    label: 'Hidden (4)',
                },
                {
                    id: 'activation-xor',
                    type: LayerType.ACTIVATION,
                    position: { x: 400, y: 300 },
                    params: { activationType: ActivationType.TANH },
                },
                {
                    id: 'output-xor',
                    type: LayerType.OUTPUT,
                    position: { x: 680, y: 250 },
                    params: { outputSize: 1 },
                    label: 'Output (1)',
                },
            ],
            connections: [
                { id: 'conn-1-xor', from: 'input-xor', to: 'linear-xor' },
                { id: 'conn-2-xor', from: 'linear-xor', to: 'activation-xor' },
                { id: 'conn-3-xor', from: 'activation-xor', to: 'output-xor' },
            ],
            metadata: {
                name: 'XOR Minimal',
                description: 'Minimal network for XOR problem',
                created: Date.now(),
                modified: Date.now(),
                tags: ['beginner', 'xor', 'classic'],
            },
        },
    },

    // ─── Wide Network ───────────────────────────────────────────────────────
    {
        id: 'wide-network',
        name: 'Wide Network',
        description: 'Single wide hidden layer for feature extraction',
        category: 'classification',
        difficulty: 2,
        useCases: ['Feature learning', 'Dimensionality expansion', 'Embeddings'],
        graph: {
            layers: [
                {
                    id: 'input-wide',
                    type: LayerType.INPUT,
                    position: { x: 100, y: 250 },
                    params: { inputSize: 2 },
                    label: 'Input',
                },
                {
                    id: 'linear-wide',
                    type: LayerType.LINEAR,
                    position: { x: 350, y: 150 },
                    params: { inputSize: 2, outputSize: 32, useBias: true },
                    label: 'Wide (32)',
                },
                {
                    id: 'activation-wide',
                    type: LayerType.ACTIVATION,
                    position: { x: 350, y: 250 },
                    params: { activationType: ActivationType.RELU },
                },
                {
                    id: 'dropout-wide',
                    type: LayerType.DROPOUT,
                    position: { x: 350, y: 350 },
                    params: { dropoutRate: 0.3 },
                },
                {
                    id: 'output-wide',
                    type: LayerType.OUTPUT,
                    position: { x: 600, y: 250 },
                    params: { outputSize: 1 },
                    label: 'Output',
                },
            ],
            connections: [
                { id: 'conn-1-wide', from: 'input-wide', to: 'linear-wide' },
                { id: 'conn-2-wide', from: 'linear-wide', to: 'activation-wide' },
                { id: 'conn-3-wide', from: 'activation-wide', to: 'dropout-wide' },
                { id: 'conn-4-wide', from: 'dropout-wide', to: 'output-wide' },
            ],
            metadata: {
                name: 'Wide Network',
                description: 'Wide single hidden layer with dropout',
                created: Date.now(),
                modified: Date.now(),
                tags: ['intermediate', 'regularization', 'wide'],
            },
        },
    },

    // ─── Autoencoder ────────────────────────────────────────────────────────
    {
        id: 'autoencoder',
        name: 'Autoencoder',
        description: 'Symmetric encoder-decoder architecture for dimensionality reduction',
        category: 'autoencoder',
        difficulty: 3,
        useCases: ['Feature compression', 'Anomaly detection', 'Denoising'],
        graph: {
            layers: [
                {
                    id: 'input-auto',
                    type: LayerType.INPUT,
                    position: { x: 50, y: 250 },
                    params: { inputSize: 8 },
                    label: 'Input (8)',
                },
                {
                    id: 'encoder-1',
                    type: LayerType.LINEAR,
                    position: { x: 220, y: 200 },
                    params: { inputSize: 8, outputSize: 4, useBias: true },
                    label: 'Encoder',
                },
                {
                    id: 'enc-act-1',
                    type: LayerType.ACTIVATION,
                    position: { x: 220, y: 300 },
                    params: { activationType: ActivationType.RELU },
                },
                {
                    id: 'bottleneck',
                    type: LayerType.LINEAR,
                    position: { x: 390, y: 250 },
                    params: { inputSize: 4, outputSize: 2, useBias: true },
                    label: 'Bottleneck (2)',
                },
                {
                    id: 'decoder-1',
                    type: LayerType.LINEAR,
                    position: { x: 560, y: 200 },
                    params: { inputSize: 2, outputSize: 4, useBias: true },
                    label: 'Decoder',
                },
                {
                    id: 'dec-act-1',
                    type: LayerType.ACTIVATION,
                    position: { x: 560, y: 300 },
                    params: { activationType: ActivationType.RELU },
                },
                {
                    id: 'output-auto',
                    type: LayerType.OUTPUT,
                    position: { x: 730, y: 250 },
                    params: { outputSize: 8 },
                    label: 'Reconstruction (8)',
                },
            ],
            connections: [
                { id: 'conn-1-auto', from: 'input-auto', to: 'encoder-1' },
                { id: 'conn-2-auto', from: 'encoder-1', to: 'enc-act-1' },
                { id: 'conn-3-auto', from: 'enc-act-1', to: 'bottleneck' },
                { id: 'conn-4-auto', from: 'bottleneck', to: 'decoder-1' },
                { id: 'conn-5-auto', from: 'decoder-1', to: 'dec-act-1' },
                { id: 'conn-6-auto', from: 'dec-act-1', to: 'output-auto' },
            ],
            metadata: {
                name: 'Autoencoder',
                description: 'Encoder-decoder with 2D bottleneck',
                created: Date.now(),
                modified: Date.now(),
                tags: ['advanced', 'autoencoder', 'compression'],
            },
        },
    },

    // ─── Temporal Network (RNN) ─────────────────────────────────────────────
    {
        id: 'temporal-rnn',
        name: 'Temporal RNN',
        description: 'Recurrent network for sequential data processing',
        category: 'timeseries',
        difficulty: 4,
        useCases: ['Time series', 'Sequential patterns', 'Motion prediction'],
        graph: {
            layers: [
                {
                    id: 'input-rnn',
                    type: LayerType.INPUT,
                    position: { x: 80, y: 250 },
                    params: { inputSize: 4 },
                    label: 'Sequence Input',
                },
                {
                    id: 'rnn-layer',
                    type: LayerType.RNN,
                    position: { x: 320, y: 200 },
                    params: { inputSize: 4, hiddenSize: 8, useBias: true },
                    label: 'RNN (8)',
                },
                {
                    id: 'rnn-act',
                    type: LayerType.ACTIVATION,
                    position: { x: 320, y: 300 },
                    params: { activationType: ActivationType.TANH },
                },
                {
                    id: 'linear-out',
                    type: LayerType.LINEAR,
                    position: { x: 560, y: 250 },
                    params: { inputSize: 8, outputSize: 4, useBias: true },
                },
                {
                    id: 'output-rnn',
                    type: LayerType.OUTPUT,
                    position: { x: 780, y: 250 },
                    params: { outputSize: 4 },
                    label: 'Prediction',
                },
            ],
            connections: [
                { id: 'conn-1-rnn', from: 'input-rnn', to: 'rnn-layer' },
                { id: 'conn-2-rnn', from: 'rnn-layer', to: 'rnn-act' },
                { id: 'conn-3-rnn', from: 'rnn-act', to: 'linear-out' },
                { id: 'conn-4-rnn', from: 'linear-out', to: 'output-rnn' },
            ],
            metadata: {
                name: 'Temporal RNN',
                description: 'RNN for sequential data',
                created: Date.now(),
                modified: Date.now(),
                tags: ['advanced', 'rnn', 'temporal', 'timeseries'],
            },
        },
    },
];

// ─── Template Utilities ─────────────────────────────────────────────────────

/**
 * Get template by ID
 */
export function getTemplateById(id: string): NetworkTemplate | undefined {
    return NETWORK_TEMPLATES.find(t => t.id === id);
}

/**
 * Get templates by category
 */
export function getTemplatesByCategory(
    category: NetworkTemplate['category']
): NetworkTemplate[] {
    return NETWORK_TEMPLATES.filter(t => t.category === category);
}

/**
 * Get templates by difficulty level
 */
export function getTemplatesByDifficulty(difficulty: number): NetworkTemplate[] {
    return NETWORK_TEMPLATES.filter(t => t.difficulty === difficulty);
}

/**
 * Get beginner-friendly templates
 */
export function getBeginnerTemplates(): NetworkTemplate[] {
    return NETWORK_TEMPLATES.filter(t => (t.difficulty ?? 5) <= 2);
}

/**
 * Get advanced templates
 */
export function getAdvancedTemplates(): NetworkTemplate[] {
    return NETWORK_TEMPLATES.filter(t => (t.difficulty ?? 1) >= 3);
}
