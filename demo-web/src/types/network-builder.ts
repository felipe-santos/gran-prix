/**
 * Network Builder Type System
 *
 * This module defines the complete type system for the drag-and-drop
 * neural network builder. It provides strong type safety and clear
 * contracts for all components.
 *
 * @module types/network-builder
 */

// ─── Layer Types ────────────────────────────────────────────────────────────

/**
 * Available layer types in the network builder
 */
export enum LayerType {
    /** Input layer - entry point of the network */
    INPUT = 'input',
    /** Fully connected linear layer */
    LINEAR = 'linear',
    /** Activation function layer */
    ACTIVATION = 'activation',
    /** Dropout regularization layer */
    DROPOUT = 'dropout',
    /** Batch normalization layer */
    BATCHNORM = 'batchnorm',
    /** Recurrent neural network layer */
    RNN = 'rnn',
    /** Gated recurrent unit layer */
    GRU = 'gru',
    /** Output layer - exit point of the network */
    OUTPUT = 'output',
}

/**
 * Activation function types
 */
export enum ActivationType {
    TANH = 'tanh',
    RELU = 'relu',
    SIGMOID = 'sigmoid',
    SOFTMAX = 'softmax',
    LINEAR = 'linear',
}

// ─── Layer Configuration ────────────────────────────────────────────────────

/**
 * 2D position in canvas space
 */
export interface Position {
    x: number;
    y: number;
}

/**
 * Base layer configuration
 */
export interface LayerConfig {
    /** Unique identifier for this layer */
    id: string;
    /** Type of the layer */
    type: LayerType;
    /** Position in the canvas (pixels) */
    position: Position;
    /** Layer-specific parameters */
    params: LayerParams;
    /** Optional custom name/label */
    label?: string;
    /** Whether this layer is locked (cannot be edited/deleted) */
    locked?: boolean;
}

/**
 * Union type for all possible layer parameters
 */
export type LayerParams =
    | InputLayerParams
    | LinearLayerParams
    | ActivationLayerParams
    | DropoutLayerParams
    | BatchNormLayerParams
    | RNNLayerParams
    | GRULayerParams
    | OutputLayerParams;

/**
 * Parameters for INPUT layer
 */
export interface InputLayerParams {
    /** Dimensionality of input features */
    inputSize: number;
}

/**
 * Parameters for LINEAR layer
 */
export interface LinearLayerParams {
    /** Input dimensionality */
    inputSize: number;
    /** Output dimensionality */
    outputSize: number;
    /** Whether to include bias term (default: true) */
    useBias?: boolean;
}

/**
 * Parameters for ACTIVATION layer
 */
export interface ActivationLayerParams {
    /** Type of activation function */
    activationType: ActivationType;
}

/**
 * Parameters for DROPOUT layer
 */
export interface DropoutLayerParams {
    /** Dropout probability (0-1) */
    dropoutRate: number;
}

/**
 * Parameters for BATCHNORM layer
 */
export interface BatchNormLayerParams {
    /** Number of features to normalize */
    numFeatures: number;
    /** Small constant for numerical stability */
    epsilon?: number;
}

/**
 * Parameters for RNN layer
 */
export interface RNNLayerParams {
    /** Input dimensionality */
    inputSize: number;
    /** Hidden state dimensionality */
    hiddenSize: number;
    /** Whether to use bias (default: true) */
    useBias?: boolean;
}

/**
 * Parameters for GRU layer
 */
export interface GRULayerParams {
    /** Input dimensionality */
    inputSize: number;
    /** Hidden state dimensionality */
    hiddenSize: number;
    /** Whether to use bias (default: true) */
    useBias?: boolean;
}

/**
 * Parameters for OUTPUT layer
 */
export interface OutputLayerParams {
    /** Output dimensionality */
    outputSize: number;
}

// ─── Connections ────────────────────────────────────────────────────────────

/**
 * Connection between two layers
 */
export interface LayerConnection {
    /** Unique identifier for this connection */
    id: string;
    /** Source layer ID */
    from: string;
    /** Target layer ID */
    to: string;
    /** Source port index (for multi-output layers) */
    fromPort?: number;
    /** Target port index (for multi-input layers) */
    toPort?: number;
}

// ─── Network Graph ──────────────────────────────────────────────────────────

/**
 * Complete neural network graph
 */
export interface NetworkGraph {
    /** All layers in the network */
    layers: LayerConfig[];
    /** All connections between layers */
    connections: LayerConnection[];
    /** Metadata about the network */
    metadata: NetworkMetadata;
}

/**
 * Metadata for a network graph
 */
export interface NetworkMetadata {
    /** Human-readable name */
    name: string;
    /** Optional description */
    description?: string;
    /** Creation timestamp */
    created: number;
    /** Last modification timestamp */
    modified: number;
    /** Optional tags for categorization */
    tags?: string[];
}

// ─── Templates ──────────────────────────────────────────────────────────────

/**
 * Template category
 */
export type TemplateCategory =
    | 'classification'
    | 'regression'
    | 'timeseries'
    | 'autoencoder'
    | 'custom';

/**
 * Pre-configured network template
 */
export interface NetworkTemplate {
    /** Unique identifier */
    id: string;
    /** Display name */
    name: string;
    /** Description of the template */
    description: string;
    /** Category for organization */
    category: TemplateCategory;
    /** The network graph */
    graph: NetworkGraph;
    /** Optional base64 thumbnail image */
    thumbnail?: string;
    /** Recommended use cases */
    useCases?: string[];
    /** Difficulty level (1-5) */
    difficulty?: number;
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Severity level for validation messages
 */
export type ValidationSeverity = 'error' | 'warning' | 'info';

/**
 * Single validation message
 */
export interface ValidationMessage {
    /** Severity level */
    severity: ValidationSeverity;
    /** Human-readable message */
    message: string;
    /** Optional layer ID this message refers to */
    layerId?: string;
    /** Optional connection ID this message refers to */
    connectionId?: string;
    /** Optional suggestion for fixing the issue */
    suggestion?: string;
}

/**
 * Result of network graph validation
 */
export interface ValidationResult {
    /** Whether the graph is valid (no errors) */
    valid: boolean;
    /** All validation messages */
    messages: ValidationMessage[];
}

// ─── Drag and Drop ──────────────────────────────────────────────────────────

/**
 * Type identifier for drag-and-drop items
 */
export enum DragItemType {
    /** Dragging a layer from palette */
    PALETTE_LAYER = 'palette_layer',
    /** Dragging an existing layer in canvas */
    CANVAS_LAYER = 'canvas_layer',
}

/**
 * Data carried when dragging from palette
 */
export interface PaletteLayerDragItem {
    type: DragItemType.PALETTE_LAYER;
    layerType: LayerType;
}

/**
 * Data carried when dragging a canvas layer
 */
export interface CanvasLayerDragItem {
    type: DragItemType.CANVAS_LAYER;
    layerId: string;
    initialPosition: Position;
}

/**
 * Union type for all drag items
 */
export type DragItem = PaletteLayerDragItem | CanvasLayerDragItem;

// ─── UI State ───────────────────────────────────────────────────────────────

/**
 * State for layer selection
 */
export interface SelectionState {
    /** Currently selected layer IDs */
    selectedLayers: string[];
    /** Currently selected connection IDs */
    selectedConnections: string[];
}

/**
 * State for connection creation
 */
export interface ConnectionDraftState {
    /** Whether user is currently drawing a connection */
    isDrawing: boolean;
    /** Source layer ID */
    fromLayerId: string | null;
    /** Current mouse position */
    currentPosition: Position | null;
}

/**
 * Canvas view state (pan/zoom)
 */
export interface CanvasViewState {
    /** Zoom level (1.0 = 100%) */
    zoom: number;
    /** Pan offset in X */
    panX: number;
    /** Pan offset in Y */
    panY: number;
}

// ─── Serialization ──────────────────────────────────────────────────────────

/**
 * Serialized format for export/import
 */
export interface SerializedNetwork {
    /** File format version */
    version: string;
    /** The network graph */
    graph: NetworkGraph;
    /** Export timestamp */
    exportedAt: number;
    /** Application version */
    appVersion?: string;
}

// ─── WASM Integration ───────────────────────────────────────────────────────

/**
 * Simplified layer configuration for WASM
 * This is what gets sent to the Rust/WASM trainer
 */
export interface WasmLayerConfig {
    /** Layer type as string */
    type: string;
    /** Flattened parameters */
    params: Record<string, number | string | boolean>;
}

/**
 * Network configuration for WASM trainer
 */
export interface WasmNetworkConfig {
    /** Input dimensionality */
    inputDim: number;
    /** Array of layer configurations */
    layers: WasmLayerConfig[];
    /** Output dimensionality */
    outputDim: number;
}

// ─── Utility Types ──────────────────────────────────────────────────────────

/**
 * Layer type guard: check if layer is INPUT
 */
export function isInputLayer(layer: LayerConfig): layer is LayerConfig & {
    type: LayerType.INPUT;
    params: InputLayerParams;
} {
    return layer.type === LayerType.INPUT;
}

/**
 * Layer type guard: check if layer is LINEAR
 */
export function isLinearLayer(layer: LayerConfig): layer is LayerConfig & {
    type: LayerType.LINEAR;
    params: LinearLayerParams;
} {
    return layer.type === LayerType.LINEAR;
}

/**
 * Layer type guard: check if layer is ACTIVATION
 */
export function isActivationLayer(layer: LayerConfig): layer is LayerConfig & {
    type: LayerType.ACTIVATION;
    params: ActivationLayerParams;
} {
    return layer.type === LayerType.ACTIVATION;
}

/**
 * Layer type guard: check if layer is OUTPUT
 */
export function isOutputLayer(layer: LayerConfig): layer is LayerConfig & {
    type: LayerType.OUTPUT;
    params: OutputLayerParams;
} {
    return layer.type === LayerType.OUTPUT;
}

/**
 * Layer type guard: check if layer is RNN
 */
export function isRNNLayer(layer: LayerConfig): layer is LayerConfig & {
    type: LayerType.RNN;
    params: RNNLayerParams;
} {
    return layer.type === LayerType.RNN;
}

/**
 * Layer type guard: check if layer is GRU
 */
export function isGRULayer(layer: LayerConfig): layer is LayerConfig & {
    type: LayerType.GRU;
    params: GRULayerParams;
} {
    return layer.type === LayerType.GRU;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Default parameters for each layer type
 */
export const DEFAULT_LAYER_PARAMS: Record<LayerType, Partial<LayerParams>> = {
    [LayerType.INPUT]: { inputSize: 2 } as InputLayerParams,
    [LayerType.LINEAR]: { inputSize: 2, outputSize: 4, useBias: true } as LinearLayerParams,
    [LayerType.ACTIVATION]: { activationType: ActivationType.TANH } as ActivationLayerParams,
    [LayerType.DROPOUT]: { dropoutRate: 0.5 } as DropoutLayerParams,
    [LayerType.BATCHNORM]: { numFeatures: 4, epsilon: 1e-5 } as BatchNormLayerParams,
    [LayerType.RNN]: { inputSize: 4, hiddenSize: 8, useBias: true } as RNNLayerParams,
    [LayerType.GRU]: { inputSize: 4, hiddenSize: 8, useBias: true } as GRULayerParams,
    [LayerType.OUTPUT]: { outputSize: 1 } as OutputLayerParams,
};

/**
 * Display names for layer types
 */
export const LAYER_TYPE_NAMES: Record<LayerType, string> = {
    [LayerType.INPUT]: 'Input',
    [LayerType.LINEAR]: 'Linear',
    [LayerType.ACTIVATION]: 'Activation',
    [LayerType.DROPOUT]: 'Dropout',
    [LayerType.BATCHNORM]: 'Batch Norm',
    [LayerType.RNN]: 'RNN',
    [LayerType.GRU]: 'GRU',
    [LayerType.OUTPUT]: 'Output',
};

/**
 * Display names for activation types
 */
export const ACTIVATION_TYPE_NAMES: Record<ActivationType, string> = {
    [ActivationType.TANH]: 'Tanh',
    [ActivationType.RELU]: 'ReLU',
    [ActivationType.SIGMOID]: 'Sigmoid',
    [ActivationType.SOFTMAX]: 'Softmax',
    [ActivationType.LINEAR]: 'Linear',
};

/**
 * Current file format version for serialization
 */
export const NETWORK_FILE_VERSION = '1.0.0';
