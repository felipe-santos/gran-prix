/**
 * NetworkSerializer
 *
 * Converts the visual NetworkGraph to the canonical Rust `NetworkDef`
 * architecture format consumed by `Trainer.fromNetworkDef`.
 *
 * @module components/playground/v2/NetworkBuilder/NetworkSerializer
 */

import {
    NetworkGraph,
    LayerConfig,
    LayerType,
    isInputLayer,
    isLinearLayer,
    isActivationLayer,
    isRNNLayer,
    isGRULayer,
    isOutputLayer,
} from '@/types/network-builder';
import { validateNetworkGraph } from './ArchitectureValidator';

type NetworkDefLayer =
    | { type: 'linear'; in_features: number; out_features: number }
    | { type: 'activation'; function: string }
    | { type: 'rnn'; input_size: number; hidden_size: number }
    | { type: 'gru'; input_size: number; hidden_size: number }
    | { type: 'dropout'; rate: number }
    | { type: 'batchnorm'; num_features: number };

export interface NetworkDefJson {
    input_dim: number;
    layers: NetworkDefLayer[];
}

export class SerializationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SerializationError';
    }
}

export function serializeNetworkDef(graph: NetworkGraph): string {
    const validation = validateNetworkGraph(graph);
    if (!validation.valid) {
        const errors = validation.messages
            .filter(m => m.severity === 'error')
            .map(m => m.message)
            .join('; ');
        throw new SerializationError(`Graph validation failed: ${errors}`);
    }

    const inputLayer = graph.layers.find(isInputLayer);
    const outputLayers = graph.layers.filter(isOutputLayer);

    if (!inputLayer) {
        throw new SerializationError('No INPUT layer found');
    }
    if (outputLayers.length === 0) {
        throw new SerializationError('No OUTPUT layer found');
    }
    if (outputLayers.length > 1) {
        throw new SerializationError('Multiple OUTPUT layers are not supported');
    }

    const sortedLayers = topologicalSort(graph, inputLayer.id, outputLayers[0].id);
    const layers = sortedLayers
        .map(convertLayerToNetworkDef)
        .filter((layer): layer is NetworkDefLayer => layer !== null);

    if (layers.length === 0) {
        throw new SerializationError('NetworkDef export produced no computation layers');
    }

    const networkDef: NetworkDefJson = {
        input_dim: inputLayer.params.inputSize,
        layers,
    };

    return JSON.stringify(networkDef, null, 2);
}

function topologicalSort(
    graph: NetworkGraph,
    inputId: string,
    outputId: string
): LayerConfig[] {
    const { layers, connections } = graph;
    const adjacency = new Map<string, string[]>();
    layers.forEach(layer => adjacency.set(layer.id, []));

    connections.forEach(conn => {
        adjacency.get(conn.from)?.push(conn.to);
    });

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

        queue.push(...(adjacency.get(currentId) || []));
    }

    if (!visited.has(outputId)) {
        throw new SerializationError('Output layer not reachable from input');
    }

    return sorted;
}

function convertLayerToNetworkDef(layer: LayerConfig): NetworkDefLayer | null {
    switch (layer.type) {
        case LayerType.INPUT:
        case LayerType.OUTPUT:
            return null;

        case LayerType.LINEAR:
            if (!isLinearLayer(layer)) return null;
            return {
                type: 'linear',
                in_features: layer.params.inputSize,
                out_features: layer.params.outputSize,
            };

        case LayerType.ACTIVATION:
            if (!isActivationLayer(layer)) return null;
            return {
                type: 'activation',
                function: layer.params.activationType,
            };

        case LayerType.RNN:
            if (!isRNNLayer(layer)) return null;
            return {
                type: 'rnn',
                input_size: layer.params.inputSize,
                hidden_size: layer.params.hiddenSize,
            };

        case LayerType.GRU:
            if (!isGRULayer(layer)) return null;
            return {
                type: 'gru',
                input_size: layer.params.inputSize,
                hidden_size: layer.params.hiddenSize,
            };

        case LayerType.DROPOUT: {
            const params = layer.params as { dropoutRate?: number };
            return {
                type: 'dropout',
                rate: params.dropoutRate ?? 0.0,
            };
        }

        case LayerType.BATCHNORM: {
            const params = layer.params as { numFeatures?: number };
            return {
                type: 'batchnorm',
                num_features: params.numFeatures ?? 1,
            };
        }

        default:
            throw new SerializationError(`Unsupported layer type: ${layer.type}`);
    }
}

export function checkWasmCompatibility(graph: NetworkGraph): string[] {
    const issues: string[] = [];

    const outputLayers = graph.layers.filter(isOutputLayer);
    if (outputLayers.length > 1) {
        issues.push('Multiple output layers are not supported');
    }

    if (!checkSequential(graph)) {
        issues.push('Non-sequential architecture (skip connections) is not supported yet');
    }

    return issues;
}

function checkSequential(graph: NetworkGraph): boolean {
    const { layers, connections } = graph;
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

    for (const layer of layers) {
        const out = outDegree.get(layer.id) || 0;
        const inp = inDegree.get(layer.id) || 0;

        if (layer.type === LayerType.INPUT) {
            if (out !== 1) return false;
        } else if (layer.type === LayerType.OUTPUT) {
            if (inp !== 1) return false;
        } else if (inp !== 1 || out !== 1) {
            return false;
        }
    }

    return true;
}

export default serializeNetworkDef;
