/**
 * Network Builder v2 - Main Exports
 *
 * Central export file for the visual neural network builder.
 *
 * @module components/playground/v2
 */

// Main component
export { NetworkBuilder } from './NetworkBuilder/NetworkBuilder';

// Sub-components (if needed separately)
export { NetworkCanvas } from './NetworkBuilder/NetworkCanvas';
export { LayerNode } from './NetworkBuilder/LayerNode';
export { LayerPalette } from './NetworkBuilder/LayerPalette';
export { Connection, ConnectionMarkers } from './NetworkBuilder/Connection';

// Templates
export { TemplateLibrary } from './Templates/TemplateLibrary';
export { NETWORK_TEMPLATES, getTemplateById, getBeginnerTemplates } from './Templates/templates';

// Utilities
export { validateNetworkGraph, isValidNetwork } from './NetworkBuilder/ArchitectureValidator';
export {
    serializeNetworkForWasm,
    serializeForTrainer,
    checkWasmCompatibility,
    SerializationError,
} from './NetworkBuilder/NetworkSerializer';

// Hooks
export { useNetworkGraph } from './shared/useNetworkGraph';
export type { UseNetworkGraphReturn } from './shared/useNetworkGraph';
