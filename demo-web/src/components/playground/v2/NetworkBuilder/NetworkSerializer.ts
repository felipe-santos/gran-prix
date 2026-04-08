/**
 * NetworkSerializer
 *
 * Converts visual NetworkGraph to WASM-compatible configuration.
 * Handles topological sort, dimension inference, and validation.
 *
 * @module components/playground/v2/NetworkBuilder/NetworkSerializer
 */

import {
    NetworkGraph,
    LayerConfig,
    LayerType,
    WasmNetworkConfig,
    WasmLayerConfig,
    isInputLayer,
    isLinearLayer,
    isActivationLayer,
    isRNNLayer,
    isGRULayer,
    isOutputLayer,
} from '@/types/network-builder';
import { validateNetworkGraph } from './ArchitectureValidator';

// ─── Serialization Error ────────────────────────────────────────────────────

export class SerializationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SerializationError';
    }
}

// ─── Serialization for Trainer.fromArchitecture ────────────────────────────

/**
 * Serializes NetworkGraph to JSON format for Trainer.fromArchitecture()
 * This includes full layer details and connections.
 *
 * @param graph - The network graph to serialize
 * @returns JSON string for WASM Trainer
 * @throws SerializationError if graph is invalid
 */
export function serializeForTrainer(graph: NetworkGraph): string {
    // 1. Validate graph
    const validation = validateNetworkGraph(graph);
    if (!validation.valid) {
        const errors = validation.messages
            .filter(m => m.severity === 'error')
            .map(m => m.message)
            .join('; ');
        throw new SerializationError(`Graph validation failed: ${errors}`);
    }

    // 2. Find input and output layers
    const inputLayer = graph.layers.find(isInputLayer);
    const outputLayer = graph.layers.find(isOutputLayer);

    if (!inputLayer) throw new SerializationError('No INPUT layer found');
    if (!outputLayer) throw new SerializationError('No OUTPUT layer found');

    // 3. Convert layers to WASM format
    const wasmLayers = graph.layers.map(layer => ({
        id: layer.id,
        type: layer.type,
        params: layer.params,
    }));

    // 4. Build architecture object
    const architecture = {
        layers: wasmLayers,
        connections: graph.connections.map(conn => ({
            from: conn.from,
            to: conn.to,
        })),
        inputDim: inputLayer.params.inputSize,
        outputDim: outputLayer.params.outputSize,
    };

    return JSON.stringify(architecture);
}

// ─── Main Serialization Function ────────────────────────────────────────────

/**
 * Converts a NetworkGraph to WASM-compatible configuration
 *
 * @param graph - The network graph to serialize
 * @returns WASM network configuration
 * @throws SerializationError if graph is invalid or unsupported
 */
export function serializeNetworkForWasm(graph: NetworkGraph): WasmNetworkConfig {
    // 1. Validate graph
    const validation = validateNetworkGraph(graph);
    if (!validation.valid) {
        const errors = validation.messages
            .filter(m => m.severity === 'error')
            .map(m => m.message)
            .join('; ');
        throw new SerializationError(`Graph validation failed: ${errors}`);
    }

    // 2. Find input and output layers
    const inputLayer = graph.layers.find(isInputLayer);
    const outputLayers = graph.layers.filter(isOutputLayer);

    if (!inputLayer) {
        throw new SerializationError('No INPUT layer found');
    }

    if (outputLayers.length === 0) {
        throw new SerializationError('No OUTPUT layer found');
    }

    if (outputLayers.length > 1) {
        throw new SerializationError('Multiple OUTPUT layers not supported in WASM mode');
    }

    const outputLayer = outputLayers[0];

    // 3. Topologically sort layers (BFS from input to output)
    const sortedLayers = topologicalSort(graph, inputLayer.id, outputLayer.id);

    // 4. Convert to WASM layer configs (exclude INPUT and OUTPUT)
    const wasmLayers: WasmLayerConfig[] = [];

    for (let i = 1; i < sortedLayers.length - 1; i++) {
        const layer = sortedLayers[i];
        const wasmLayer = convertLayerToWasm(layer);
        if (wasmLayer) {
            wasmLayers.push(wasmLayer);
        }
    }

    // 5. Build final config
    const config: WasmNetworkConfig = {
        inputDim: inputLayer.params.inputSize,
        outputDim: outputLayer.params.outputSize,
        layers: wasmLayers,
    };

    return config;
}

// ─── Topological Sort ───────────────────────────────────────────────────────

/**
 * Topologically sorts layers from input to output
 *
 * @param graph - The network graph
 * @param inputId - ID of input layer
 * @param outputId - ID of output layer
 * @returns Sorted array of layers
 */
function topologicalSort(
    graph: NetworkGraph,
    inputId: string,
    outputId: string
): LayerConfig[] {
    const { layers, connections } = graph;

    // Build adjacency list
    const adjacency = new Map<string, string[]>();
    layers.forEach(layer => adjacency.set(layer.id, []));

    connections.forEach(conn => {
        adjacency.get(conn.from)?.push(conn.to);
    });

    // BFS from input
    const sorted: LayerConfig[] = [];
    const visited = new Set<string>();
    const queue = [inputId];

    while (queue.length > 0) {
        const currentId = queue.shift()!;
        if (visited.has(currentId)) continue;

        visited.add(currentId);
        const layer = layers.find(l => l.id === currentId);
        if (layer) {
            sorted.push(layer);
        }

        // Add children to queue
        const children = adjacency.get(currentId) || [];
        queue.push(...children);
    }

    // Verify output is reachable
    if (!visited.has(outputId)) {
        throw new SerializationError('Output layer not reachable from input');
    }

    return sorted;
}

// ─── Layer Conversion ───────────────────────────────────────────────────────

/**
 * Converts a visual layer to WASM layer config
 *
 * @param layer - The layer to convert
 * @returns WASM layer config or null if layer should be skipped
 */
function convertLayerToWasm(layer: LayerConfig): WasmLayerConfig | null {
    switch (layer.type) {
        case LayerType.INPUT:
        case LayerType.OUTPUT:
            // These are handled separately
            return null;

        case LayerType.LINEAR:
            if (isLinearLayer(layer)) {
                return {
                    type: 'linear',
                    params: {
                        inputSize: layer.params.inputSize,
                        outputSize: layer.params.outputSize,
                        useBias: layer.params.useBias ?? true,
                    },
                };
            }
            return null;

        case LayerType.ACTIVATION:
            if (isActivationLayer(layer)) {
                return {
                    type: 'activation',
                    params: {
                        activationType: layer.params.activationType,
                    },
                };
            }
            return null;

        case LayerType.RNN:
            if (isRNNLayer(layer)) {
                return {
                    type: 'rnn',
                    params: {
                        inputSize: layer.params.inputSize,
                        hiddenSize: layer.params.hiddenSize,
                        useBias: layer.params.useBias ?? true,
                    },
                };
            }
            return null;

        case LayerType.GRU:
            if (isGRULayer(layer)) {
                return {
                    type: 'gru',
                    params: {
                        inputSize: layer.params.inputSize,
                        hiddenSize: layer.params.hiddenSize,
                        useBias: layer.params.useBias ?? true,
                    },
                };
            }
            return null;

        case LayerType.DROPOUT:
            return {
                type: 'dropout',
                params: {
                    dropoutRate: (layer.params as any).dropoutRate ?? 0.5,
                },
            };

        case LayerType.BATCHNORM:
            return {
                type: 'batchnorm',
                params: {
                    numFeatures: (layer.params as any).numFeatures,
                    epsilon: (layer.params as any).epsilon ?? 1e-5,
                },
            };

        default:
            console.warn(`Unknown layer type: ${layer.type}`);
            return null;
    }
}

// ─── Compatibility Checks ───────────────────────────────────────────────────

/**
 * Checks if a graph can be serialized for current WASM trainer
 *
 * Current limitations:
 * - Only fully sequential networks (no skip connections)
 * - Single output layer
 * - Limited layer types (Linear, Activation, RNN, GRU supported)
 *
 * @param graph - The network graph
 * @returns Array of compatibility issues (empty if compatible)
 */
export function checkWasmCompatibility(graph: NetworkGraph): string[] {
    const issues: string[] = [];

    // Check for multiple outputs
    const outputLayers = graph.layers.filter(isOutputLayer);
    if (outputLayers.length > 1) {
        issues.push('Multiple output layers not supported');
    }

    // Check for skip connections (non-sequential)
    const isSequential = checkSequential(graph);
    if (!isSequential) {
        issues.push('Non-sequential architecture (skip connections) not yet supported');
    }

    // Check for unsupported layer types
    const unsupportedLayers = graph.layers.filter(
        layer =>
            layer.type !== LayerType.INPUT &&
            layer.type !== LayerType.OUTPUT &&
            layer.type !== LayerType.LINEAR &&
            layer.type !== LayerType.ACTIVATION &&
            layer.type !== LayerType.RNN &&
            layer.type !== LayerType.GRU &&
            layer.type !== LayerType.DROPOUT &&
            layer.type !== LayerType.BATCHNORM
    );

    if (unsupportedLayers.length > 0) {
        const types = unsupportedLayers.map(l => l.type).join(', ');
        issues.push(`Unsupported layer types: ${types}`);
    }

    return issues;
}

/**
 * Checks if network is fully sequential (no skip connections)
 */
function checkSequential(graph: NetworkGraph): boolean {
    const { layers, connections } = graph;

    // Build in/out degree maps
    const outDegree = new Map<string, number>();
    const inDegree = new Map<string, number>();

    layers.forEach(layer => {
        outDegree.set(layer.id, 0);
        inDegree.set(layer.id, 0);
    });

    connections.forEach(conn => {
        outDegree.set(conn.from, (outDegree.get(conn.from) || 0) + 1);
        inDegree.set(conn.to, (inDegree.get(conn.to) || 0) + 1);
    });

    // Sequential means:
    // - Input layer has out-degree 1
    // - Output layer has in-degree 1
    // - All middle layers have in-degree 1 and out-degree 1

    for (const layer of layers) {
        const out = outDegree.get(layer.id) || 0;
        const inp = inDegree.get(layer.id) || 0;

        if (layer.type === LayerType.INPUT) {
            if (out !== 1) return false;
        } else if (layer.type === LayerType.OUTPUT) {
            if (inp !== 1) return false;
        } else {
            if (inp !== 1 || out !== 1) return false;
        }
    }

    return true;
}

// ─── Import from WASM ───────────────────────────────────────────────────────

/**
 * Converts WASM config back to NetworkGraph (for import/persistence)
 *
 * @param config - WASM network configuration
 * @returns NetworkGraph
 */
export function deserializeNetworkFromWasm(config: WasmNetworkConfig): NetworkGraph {
    const layers: LayerConfig[] = [];
    const connections: LayerConnection[] = [];

    // Create input layer
    const inputId = 'input-imported';
    layers.push({
        id: inputId,
        type: LayerType.INPUT,
        position: { x: 100, y: 300 },
        params: { inputSize: config.inputDim },
        label: 'Input',
    });

    let prevLayerId = inputId;
    let x = 300;

    // Create middle layers
    config.layers.forEach((wasmLayer, index) => {
        const layerId = `layer-${index}-imported`;
        const y = 200 + (index % 3) * 100; // Stagger vertically

        let layerConfig: LayerConfig | null = null;

        switch (wasmLayer.type) {
            case 'linear':
                layerConfig = {
                    id: layerId,
                    type: LayerType.LINEAR,
                    position: { x, y },
                    params: {
                        inputSize: wasmLayer.params.inputSize as number,
                        outputSize: wasmLayer.params.outputSize as number,
                        useBias: wasmLayer.params.useBias as boolean,
                    },
                };
                break;

            case 'activation':
                layerConfig = {
                    id: layerId,
                    type: LayerType.ACTIVATION,
                    position: { x, y },
                    params: {
                        activationType: wasmLayer.params.activationType as any,
                    },
                };
                break;

            // Add other layer types as needed
        }

        if (layerConfig) {
            layers.push(layerConfig);
            connections.push({
                id: `conn-${index}-imported`,
                from: prevLayerId,
                to: layerId,
            });
            prevLayerId = layerId;
            x += 200;
        }
    });

    // Create output layer
    const outputId = 'output-imported';
    layers.push({
        id: outputId,
        type: LayerType.OUTPUT,
        position: { x: x + 100, y: 300 },
        params: { outputSize: config.outputDim },
        label: 'Output',
    });

    connections.push({
        id: 'conn-final-imported',
        from: prevLayerId,
        to: outputId,
    });

    return {
        layers,
        connections,
        metadata: {
            name: 'Imported Network',
            description: 'Imported from WASM configuration',
            created: Date.now(),
            modified: Date.now(),
            tags: ['imported'],
        },
    };
}

// ─── Export ─────────────────────────────────────────────────────────────────

export default serializeNetworkForWasm;
