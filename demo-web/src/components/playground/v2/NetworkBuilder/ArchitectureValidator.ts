/**
 * Architecture Validator
 *
 * Validates neural network architectures to ensure they are:
 * - Topologically valid (no cycles, connected graph)
 * - Dimensionally compatible (layer inputs/outputs match)
 * - Structurally sound (has input and output layers)
 *
 * @module components/playground/v2/NetworkBuilder/ArchitectureValidator
 */

import {
    NetworkGraph,
    ValidationResult,
    ValidationMessage,
    LayerConfig,
    LayerConnection,
    LayerType,
    isInputLayer,
    isLinearLayer,
    isRNNLayer,
    isGRULayer,
    isOutputLayer,
} from '@/types/network-builder';

// ─── Main Validation Function ──────────────────────────────────────────────

/**
 * Validates a complete network graph
 *
 * @param graph - The network graph to validate
 * @returns Validation result with messages
 */
export function validateNetworkGraph(graph: NetworkGraph): ValidationResult {
    const messages: ValidationMessage[] = [];

    // Run all validation checks
    validateStructure(graph, messages);
    validateTopology(graph, messages);
    validateDimensions(graph, messages);
    validateLayerParams(graph, messages);

    // Determine if valid (no errors)
    const valid = !messages.some(m => m.severity === 'error');

    return { valid, messages };
}

// ─── Structural Validation ─────────────────────────────────────────────────

/**
 * Validates basic structural requirements:
 * - Exactly one INPUT layer
 * - At least one OUTPUT layer
 * - No duplicate layer IDs
 * - No duplicate connection IDs
 */
function validateStructure(
    graph: NetworkGraph,
    messages: ValidationMessage[]
): void {
    const { layers, connections } = graph;

    // Check for INPUT layers
    const inputLayers = layers.filter(isInputLayer);
    if (inputLayers.length === 0) {
        messages.push({
            severity: 'error',
            message: 'Network must have exactly one INPUT layer',
            suggestion: 'Add an INPUT layer from the palette',
        });
    } else if (inputLayers.length > 1) {
        messages.push({
            severity: 'error',
            message: 'Network cannot have multiple INPUT layers',
            suggestion: 'Remove extra INPUT layers',
        });
        inputLayers.slice(1).forEach(layer => {
            messages.push({
                severity: 'error',
                message: `Duplicate INPUT layer detected`,
                layerId: layer.id,
            });
        });
    }

    // Check for OUTPUT layers
    const outputLayers = layers.filter(isOutputLayer);
    if (outputLayers.length === 0) {
        messages.push({
            severity: 'error',
            message: 'Network must have at least one OUTPUT layer',
            suggestion: 'Add an OUTPUT layer from the palette',
        });
    }

    // Check for duplicate layer IDs
    const layerIds = new Set<string>();
    layers.forEach(layer => {
        if (layerIds.has(layer.id)) {
            messages.push({
                severity: 'error',
                message: `Duplicate layer ID: ${layer.id}`,
                layerId: layer.id,
            });
        }
        layerIds.add(layer.id);
    });

    // Check for duplicate connection IDs
    const connectionIds = new Set<string>();
    connections.forEach(conn => {
        if (connectionIds.has(conn.id)) {
            messages.push({
                severity: 'error',
                message: `Duplicate connection ID: ${conn.id}`,
                connectionId: conn.id,
            });
        }
        connectionIds.add(conn.id);
    });

    // Check for dangling connections (references non-existent layers)
    connections.forEach(conn => {
        if (!layerIds.has(conn.from)) {
            messages.push({
                severity: 'error',
                message: `Connection references non-existent layer: ${conn.from}`,
                connectionId: conn.id,
            });
        }
        if (!layerIds.has(conn.to)) {
            messages.push({
                severity: 'error',
                message: `Connection references non-existent layer: ${conn.to}`,
                connectionId: conn.id,
            });
        }
    });
}

// ─── Topological Validation ────────────────────────────────────────────────

/**
 * Validates topology:
 * - No cycles (DAG - Directed Acyclic Graph)
 * - All layers except INPUT have incoming connections
 * - All layers except OUTPUT have outgoing connections (warning)
 * - INPUT layer is reachable from all other layers
 */
function validateTopology(
    graph: NetworkGraph,
    messages: ValidationMessage[]
): void {
    const { layers, connections } = graph;

    // Build adjacency lists
    const outgoing = new Map<string, string[]>();
    const incoming = new Map<string, string[]>();

    layers.forEach(layer => {
        outgoing.set(layer.id, []);
        incoming.set(layer.id, []);
    });

    connections.forEach(conn => {
        outgoing.get(conn.from)?.push(conn.to);
        incoming.get(conn.to)?.push(conn.from);
    });

    // Check for cycles using DFS
    const hasCycle = detectCycle(layers.map(l => l.id), outgoing);
    if (hasCycle) {
        messages.push({
            severity: 'error',
            message: 'Network contains a cycle (circular dependency)',
            suggestion: 'Remove connections that create loops',
        });
    }

    // Check for disconnected layers
    layers.forEach(layer => {
        // Non-INPUT layers should have incoming connections
        if (layer.type !== LayerType.INPUT) {
            const incomingCount = incoming.get(layer.id)?.length || 0;
            if (incomingCount === 0) {
                messages.push({
                    severity: 'error',
                    message: `Layer has no incoming connections`,
                    layerId: layer.id,
                    suggestion: 'Connect this layer to a previous layer',
                });
            }
        }

        // Non-OUTPUT layers should have outgoing connections (warning only)
        if (layer.type !== LayerType.OUTPUT) {
            const outgoingCount = outgoing.get(layer.id)?.length || 0;
            if (outgoingCount === 0) {
                messages.push({
                    severity: 'warning',
                    message: `Layer has no outgoing connections`,
                    layerId: layer.id,
                    suggestion: 'This layer is not contributing to the output',
                });
            }
        }
    });

    // Check if INPUT is reachable from all layers
    const inputLayers = layers.filter(isInputLayer);
    if (inputLayers.length === 1) {
        const inputId = inputLayers[0].id;
        const reachable = getReachableNodes(inputId, outgoing);

        layers.forEach(layer => {
            if (layer.id !== inputId && !reachable.has(layer.id)) {
                messages.push({
                    severity: 'error',
                    message: `Layer is not reachable from INPUT`,
                    layerId: layer.id,
                    suggestion: 'Ensure there is a path from INPUT to this layer',
                });
            }
        });
    }
}

/**
 * Detects cycles in directed graph using DFS
 */
function detectCycle(
    nodes: string[],
    adjacency: Map<string, string[]>
): boolean {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    function dfs(node: string): boolean {
        visited.add(node);
        recursionStack.add(node);

        const neighbors = adjacency.get(node) || [];
        for (const neighbor of neighbors) {
            if (!visited.has(neighbor)) {
                if (dfs(neighbor)) return true;
            } else if (recursionStack.has(neighbor)) {
                return true; // Cycle detected
            }
        }

        recursionStack.delete(node);
        return false;
    }

    for (const node of nodes) {
        if (!visited.has(node)) {
            if (dfs(node)) return true;
        }
    }

    return false;
}

/**
 * Gets all nodes reachable from a starting node
 */
function getReachableNodes(
    start: string,
    adjacency: Map<string, string[]>
): Set<string> {
    const reachable = new Set<string>();
    const queue = [start];

    while (queue.length > 0) {
        const current = queue.shift()!;
        if (reachable.has(current)) continue;

        reachable.add(current);
        const neighbors = adjacency.get(current) || [];
        queue.push(...neighbors);
    }

    return reachable;
}

// ─── Dimensional Validation ────────────────────────────────────────────────

/**
 * Validates that layer dimensions are compatible across connections
 */
function validateDimensions(
    graph: NetworkGraph,
    messages: ValidationMessage[]
): void {
    const { layers, connections } = graph;

    // Build layer map for quick lookup
    const layerMap = new Map<string, LayerConfig>();
    layers.forEach(layer => layerMap.set(layer.id, layer));

    // Check each connection
    connections.forEach(conn => {
        const fromLayer = layerMap.get(conn.from);
        const toLayer = layerMap.get(conn.to);

        if (!fromLayer || !toLayer) return; // Already caught in structure validation

        const fromOutputDim = getLayerOutputDim(fromLayer);
        const toInputDim = getLayerInputDim(toLayer);

        // If both dimensions are known, check compatibility
        if (fromOutputDim !== null && toInputDim !== null) {
            if (fromOutputDim !== toInputDim) {
                messages.push({
                    severity: 'error',
                    message: `Dimension mismatch: ${fromLayer.id} outputs ${fromOutputDim}, but ${toLayer.id} expects ${toInputDim}`,
                    connectionId: conn.id,
                    suggestion: `Adjust layer dimensions to match`,
                });
            }
        }
    });
}

/**
 * Gets the output dimensionality of a layer
 * Returns null if dimension passes through unchanged
 */
function getLayerOutputDim(layer: LayerConfig): number | null {
    switch (layer.type) {
        case LayerType.INPUT:
            if (isInputLayer(layer)) {
                return layer.params.inputSize;
            }
            return null;

        case LayerType.LINEAR:
            if (isLinearLayer(layer)) {
                return layer.params.outputSize;
            }
            return null;

        case LayerType.RNN:
            if (isRNNLayer(layer)) {
                return layer.params.hiddenSize;
            }
            return null;

        case LayerType.GRU:
            if (isGRULayer(layer)) {
                return layer.params.hiddenSize;
            }
            return null;

        case LayerType.OUTPUT:
            if (isOutputLayer(layer)) {
                return layer.params.outputSize;
            }
            return null;

        // These layers pass through dimensions unchanged
        case LayerType.ACTIVATION:
        case LayerType.DROPOUT:
        case LayerType.BATCHNORM:
            return null;

        default:
            return null;
    }
}

/**
 * Gets the expected input dimensionality of a layer
 * Returns null if layer accepts any dimension
 */
function getLayerInputDim(layer: LayerConfig): number | null {
    switch (layer.type) {
        case LayerType.LINEAR:
            if (isLinearLayer(layer)) {
                return layer.params.inputSize;
            }
            return null;

        case LayerType.RNN:
            if (isRNNLayer(layer)) {
                return layer.params.inputSize;
            }
            return null;

        case LayerType.GRU:
            if (isGRULayer(layer)) {
                return layer.params.inputSize;
            }
            return null;

        case LayerType.BATCHNORM:
            // BatchNorm expects specific dimension
            return (layer.params as any).numFeatures || null;

        // These layers accept any dimension
        case LayerType.INPUT:
        case LayerType.ACTIVATION:
        case LayerType.DROPOUT:
        case LayerType.OUTPUT:
            return null;

        default:
            return null;
    }
}

// ─── Layer Parameter Validation ────────────────────────────────────────────

/**
 * Validates individual layer parameters
 */
function validateLayerParams(
    graph: NetworkGraph,
    messages: ValidationMessage[]
): void {
    graph.layers.forEach(layer => {
        switch (layer.type) {
            case LayerType.INPUT:
                if (isInputLayer(layer)) {
                    if (layer.params.inputSize < 1) {
                        messages.push({
                            severity: 'error',
                            message: 'Input size must be at least 1',
                            layerId: layer.id,
                        });
                    }
                }
                break;

            case LayerType.LINEAR:
                if (isLinearLayer(layer)) {
                    if (layer.params.inputSize < 1) {
                        messages.push({
                            severity: 'error',
                            message: 'Linear layer input size must be at least 1',
                            layerId: layer.id,
                        });
                    }
                    if (layer.params.outputSize < 1) {
                        messages.push({
                            severity: 'error',
                            message: 'Linear layer output size must be at least 1',
                            layerId: layer.id,
                        });
                    }
                }
                break;

            case LayerType.RNN:
                if (isRNNLayer(layer)) {
                    if (layer.params.inputSize < 1) {
                        messages.push({
                            severity: 'error',
                            message: 'RNN input size must be at least 1',
                            layerId: layer.id,
                        });
                    }
                    if (layer.params.hiddenSize < 1) {
                        messages.push({
                            severity: 'error',
                            message: 'RNN hidden size must be at least 1',
                            layerId: layer.id,
                        });
                    }
                }
                break;

            case LayerType.GRU:
                if (isGRULayer(layer)) {
                    if (layer.params.inputSize < 1) {
                        messages.push({
                            severity: 'error',
                            message: 'GRU input size must be at least 1',
                            layerId: layer.id,
                        });
                    }
                    if (layer.params.hiddenSize < 1) {
                        messages.push({
                            severity: 'error',
                            message: 'GRU hidden size must be at least 1',
                            layerId: layer.id,
                        });
                    }
                }
                break;

            case LayerType.OUTPUT:
                if (isOutputLayer(layer)) {
                    if (layer.params.outputSize < 1) {
                        messages.push({
                            severity: 'error',
                            message: 'Output size must be at least 1',
                            layerId: layer.id,
                        });
                    }
                }
                break;

            case LayerType.DROPOUT:
                const dropoutRate = (layer.params as any).dropoutRate;
                if (dropoutRate !== undefined) {
                    if (dropoutRate < 0 || dropoutRate > 1) {
                        messages.push({
                            severity: 'error',
                            message: 'Dropout rate must be between 0 and 1',
                            layerId: layer.id,
                        });
                    }
                }
                break;
        }
    });
}

// ─── Utility Functions ──────────────────────────────────────────────────────

/**
 * Quick check if a graph is valid (no errors)
 */
export function isValidNetwork(graph: NetworkGraph): boolean {
    const result = validateNetworkGraph(graph);
    return result.valid;
}

/**
 * Get only error messages
 */
export function getErrors(result: ValidationResult): ValidationMessage[] {
    return result.messages.filter(m => m.severity === 'error');
}

/**
 * Get only warning messages
 */
export function getWarnings(result: ValidationResult): ValidationMessage[] {
    return result.messages.filter(m => m.severity === 'warning');
}

/**
 * Get only info messages
 */
export function getInfo(result: ValidationResult): ValidationMessage[] {
    return result.messages.filter(m => m.severity === 'info');
}
