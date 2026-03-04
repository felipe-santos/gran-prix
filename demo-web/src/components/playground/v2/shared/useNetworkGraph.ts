/**
 * useNetworkGraph Hook
 *
 * Central state management hook for neural network graph construction.
 * Provides a clean API for manipulating layers, connections, and metadata.
 *
 * @module components/playground/v2/shared/useNetworkGraph
 */

import { useState, useCallback, useMemo } from 'react';
import {
    NetworkGraph,
    LayerConfig,
    LayerConnection,
    LayerType,
    NetworkTemplate,
    ValidationResult,
    Position,
    DEFAULT_LAYER_PARAMS,
} from '@/types/network-builder';
import { validateNetworkGraph } from '../NetworkBuilder/ArchitectureValidator';

// ─── Hook Return Type ───────────────────────────────────────────────────────

export interface UseNetworkGraphReturn {
    /** Current network graph state */
    graph: NetworkGraph;

    /** Add a new layer to the graph */
    addLayer: (layer: Omit<LayerConfig, 'id'>) => string;

    /** Remove a layer and its connections */
    removeLayer: (layerId: string) => void;

    /** Update layer properties */
    updateLayer: (layerId: string, updates: Partial<LayerConfig>) => void;

    /** Move a layer to a new position */
    moveLayer: (layerId: string, position: Position) => void;

    /** Add a connection between layers */
    addConnection: (connection: Omit<LayerConnection, 'id'>) => string;

    /** Remove a connection */
    removeConnection: (connectionId: string) => void;

    /** Load a template */
    loadTemplate: (template: NetworkTemplate) => void;

    /** Clear the entire graph */
    clearGraph: () => void;

    /** Validate current graph */
    validate: () => ValidationResult;

    /** Get validation result (memoized) */
    validationResult: ValidationResult;

    /** Check if graph is valid */
    isValid: boolean;

    /** Undo last action */
    undo: () => void;

    /** Redo last undone action */
    redo: () => void;

    /** Whether undo is available */
    canUndo: boolean;

    /** Whether redo is available */
    canRedo: boolean;
}

// ─── Hook Options ───────────────────────────────────────────────────────────

export interface UseNetworkGraphOptions {
    /** Initial graph state */
    initialGraph?: NetworkGraph;

    /** Maximum undo history size */
    maxHistorySize?: number;

    /** Callback when graph changes */
    onChange?: (graph: NetworkGraph) => void;

    /** Callback when validation changes */
    onValidationChange?: (result: ValidationResult) => void;
}

// ─── Hook Implementation ────────────────────────────────────────────────────

export function useNetworkGraph(
    options: UseNetworkGraphOptions = {}
): UseNetworkGraphReturn {
    const {
        initialGraph,
        maxHistorySize = 50,
        onChange,
        onValidationChange,
    } = options;

    // ─── State ──────────────────────────────────────────────────────────────

    const [graph, setGraphInternal] = useState<NetworkGraph>(
        initialGraph || createEmptyGraph()
    );

    const [history, setHistory] = useState<NetworkGraph[]>([]);
    const [historyIndex, setHistoryIndex] = useState(-1);

    // ─── Set Graph with History ─────────────────────────────────────────────

    const setGraph = useCallback(
        (newGraph: NetworkGraph) => {
            setGraphInternal(newGraph);

            // Update history
            setHistory(prev => {
                const newHistory = prev.slice(0, historyIndex + 1);
                newHistory.push(newGraph);

                // Limit history size
                if (newHistory.length > maxHistorySize) {
                    newHistory.shift();
                } else {
                    setHistoryIndex(i => i + 1);
                }

                return newHistory;
            });

            // Trigger onChange callback
            if (onChange) {
                onChange(newGraph);
            }
        },
        [historyIndex, maxHistorySize, onChange]
    );

    // ─── Layer Operations ───────────────────────────────────────────────────

    const addLayer = useCallback(
        (layer: Omit<LayerConfig, 'id'>): string => {
            const id = generateLayerId(layer.type);
            const newLayer: LayerConfig = { ...layer, id };

            setGraph({
                ...graph,
                layers: [...graph.layers, newLayer],
                metadata: {
                    ...graph.metadata,
                    modified: Date.now(),
                },
            });

            return id;
        },
        [graph, setGraph]
    );

    const removeLayer = useCallback(
        (layerId: string) => {
            setGraph({
                ...graph,
                layers: graph.layers.filter(l => l.id !== layerId),
                connections: graph.connections.filter(
                    c => c.from !== layerId && c.to !== layerId
                ),
                metadata: {
                    ...graph.metadata,
                    modified: Date.now(),
                },
            });
        },
        [graph, setGraph]
    );

    const updateLayer = useCallback(
        (layerId: string, updates: Partial<LayerConfig>) => {
            setGraph({
                ...graph,
                layers: graph.layers.map(l =>
                    l.id === layerId ? { ...l, ...updates } : l
                ),
                metadata: {
                    ...graph.metadata,
                    modified: Date.now(),
                },
            });
        },
        [graph, setGraph]
    );

    const moveLayer = useCallback(
        (layerId: string, position: Position) => {
            updateLayer(layerId, { position });
        },
        [updateLayer]
    );

    // ─── Connection Operations ──────────────────────────────────────────────

    const addConnection = useCallback(
        (connection: Omit<LayerConnection, 'id'>): string => {
            // Check if connection already exists
            const exists = graph.connections.some(
                c => c.from === connection.from && c.to === connection.to
            );

            if (exists) {
                console.warn('Connection already exists');
                return '';
            }

            const id = generateConnectionId(connection.from, connection.to);
            const newConnection: LayerConnection = { ...connection, id };

            setGraph({
                ...graph,
                connections: [...graph.connections, newConnection],
                metadata: {
                    ...graph.metadata,
                    modified: Date.now(),
                },
            });

            return id;
        },
        [graph, setGraph]
    );

    const removeConnection = useCallback(
        (connectionId: string) => {
            setGraph({
                ...graph,
                connections: graph.connections.filter(c => c.id !== connectionId),
                metadata: {
                    ...graph.metadata,
                    modified: Date.now(),
                },
            });
        },
        [graph, setGraph]
    );

    // ─── Template Operations ────────────────────────────────────────────────

    const loadTemplate = useCallback(
        (template: NetworkTemplate) => {
            setGraph({
                ...template.graph,
                metadata: {
                    ...template.graph.metadata,
                    modified: Date.now(),
                },
            });
        },
        [setGraph]
    );

    const clearGraph = useCallback(() => {
        setGraph(createEmptyGraph());
    }, [setGraph]);

    // ─── Validation ─────────────────────────────────────────────────────────

    const validationResult = useMemo(() => {
        const result = validateNetworkGraph(graph);

        // Trigger validation change callback
        if (onValidationChange) {
            onValidationChange(result);
        }

        return result;
    }, [graph, onValidationChange]);

    const validate = useCallback(() => {
        return validationResult;
    }, [validationResult]);

    const isValid = useMemo(() => {
        return validationResult.valid;
    }, [validationResult]);

    // ─── History (Undo/Redo) ────────────────────────────────────────────────

    const undo = useCallback(() => {
        if (historyIndex > 0) {
            const newIndex = historyIndex - 1;
            setHistoryIndex(newIndex);
            setGraphInternal(history[newIndex]);

            if (onChange) {
                onChange(history[newIndex]);
            }
        }
    }, [historyIndex, history, onChange]);

    const redo = useCallback(() => {
        if (historyIndex < history.length - 1) {
            const newIndex = historyIndex + 1;
            setHistoryIndex(newIndex);
            setGraphInternal(history[newIndex]);

            if (onChange) {
                onChange(history[newIndex]);
            }
        }
    }, [historyIndex, history, onChange]);

    const canUndo = historyIndex > 0;
    const canRedo = historyIndex < history.length - 1;

    // ─── Return ─────────────────────────────────────────────────────────────

    return {
        graph,
        addLayer,
        removeLayer,
        updateLayer,
        moveLayer,
        addConnection,
        removeConnection,
        loadTemplate,
        clearGraph,
        validate,
        validationResult,
        isValid,
        undo,
        redo,
        canUndo,
        canRedo,
    };
}

// ─── Utility Functions ──────────────────────────────────────────────────────

/**
 * Creates an empty network graph
 */
function createEmptyGraph(): NetworkGraph {
    return {
        layers: [],
        connections: [],
        metadata: {
            name: 'Untitled Network',
            created: Date.now(),
            modified: Date.now(),
        },
    };
}

/**
 * Generates a unique layer ID
 */
function generateLayerId(type: LayerType): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 9);
    return `${type}-${timestamp}-${random}`;
}

/**
 * Generates a unique connection ID
 */
function generateConnectionId(from: string, to: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 9);
    return `conn-${from}-${to}-${timestamp}-${random}`;
}

// ─── Export Hook Creator ────────────────────────────────────────────────────

/**
 * Creates a network graph with a simple architecture pre-loaded
 */
export function createSimpleNetwork(): NetworkGraph {
    const timestamp = Date.now();

    return {
        layers: [
            {
                id: `input-${timestamp}`,
                type: LayerType.INPUT,
                position: { x: 100, y: 250 },
                params: { inputSize: 2 },
            },
            {
                id: `linear-1-${timestamp}`,
                type: LayerType.LINEAR,
                position: { x: 350, y: 200 },
                params: { inputSize: 2, outputSize: 4, useBias: true },
            },
            {
                id: `activation-1-${timestamp}`,
                type: LayerType.ACTIVATION,
                position: { x: 350, y: 300 },
                params: { activationType: 'tanh' as any },
            },
            {
                id: `output-${timestamp}`,
                type: LayerType.OUTPUT,
                position: { x: 600, y: 250 },
                params: { outputSize: 1 },
            },
        ],
        connections: [
            {
                id: `conn-1-${timestamp}`,
                from: `input-${timestamp}`,
                to: `linear-1-${timestamp}`,
            },
            {
                id: `conn-2-${timestamp}`,
                from: `linear-1-${timestamp}`,
                to: `activation-1-${timestamp}`,
            },
            {
                id: `conn-3-${timestamp}`,
                from: `activation-1-${timestamp}`,
                to: `output-${timestamp}`,
            },
        ],
        metadata: {
            name: 'Simple Network',
            description: 'Basic feedforward network',
            created: timestamp,
            modified: timestamp,
        },
    };
}
