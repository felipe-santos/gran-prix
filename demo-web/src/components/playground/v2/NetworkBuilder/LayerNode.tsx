/**
 * LayerNode Component
 *
 * Visual representation of a neural network layer in the canvas.
 * Supports drag-and-drop, connection points, and parameter editing.
 *
 * @module components/playground/v2/NetworkBuilder/LayerNode
 */

import React, { useRef } from 'react';
import { useDraggable } from '@dnd-kit/core';
import {
    LayerConfig,
    LayerType,
    ActivationType,
    LAYER_TYPE_NAMES,
    ACTIVATION_TYPE_NAMES,
    isInputLayer,
    isLinearLayer,
    isActivationLayer,
    isRNNLayer,
    isGRULayer,
    isOutputLayer,
} from '@/types/network-builder';
import { Settings, Trash2, Lock, Circle } from 'lucide-react';

// ─── Component Props ────────────────────────────────────────────────────────

interface LayerNodeProps {
    /** Layer configuration */
    layer: LayerConfig;
    /** Whether this node is currently selected */
    isSelected?: boolean;
    /** Whether this node is locked (cannot be edited/deleted) */
    isLocked?: boolean;
    /** Whether to show connection points */
    showConnectionPoints?: boolean;
    /** Callback when layer is clicked */
    onClick?: () => void;
    /** Callback when settings button is clicked */
    onSettings?: () => void;
    /** Callback when delete button is clicked */
    onDelete?: () => void;
    /** Callback when output connection point is clicked */
    onOutputClick?: () => void;
    /** Callback when input connection point is clicked */
    onInputClick?: () => void;
}

// ─── Main Component ─────────────────────────────────────────────────────────

export const LayerNode: React.FC<LayerNodeProps> = ({
    layer,
    isSelected = false,
    isLocked = false,
    showConnectionPoints = true,
    onClick,
    onSettings,
    onDelete,
    onOutputClick,
    onInputClick,
}) => {
    const nodeRef = useRef<HTMLDivElement>(null);

    // Setup drag-and-drop (only if not locked)
    const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
        id: layer.id,
        disabled: isLocked,
        data: {
            type: 'canvas_layer',
            layerId: layer.id,
        },
    });

    // Calculate transform for dragging
    const style = transform
        ? {
              transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
          }
        : undefined;

    // Get visual properties
    const icon = getLayerIcon(layer.type);
    const colorClass = getLayerColorClass(layer.type);
    const description = getLayerDescription(layer);

    return (
        <div
            ref={setNodeRef}
            style={{
                position: 'absolute',
                left: layer.position.x,
                top: layer.position.y,
                opacity: isDragging ? 0.5 : 1,
                zIndex: isSelected ? 10 : 1,
                ...style,
            }}
            onClick={onClick}
            className={`
                relative group
                min-w-[160px] max-w-[200px]
                bg-card
                rounded-xl shadow-lg
                transition-all duration-200
                ${isSelected ? 'ring-4 ring-cyan-500/50 shadow-2xl scale-105' : 'hover:shadow-2xl hover:scale-[1.02]'}
                ${!isLocked ? 'hover:ring-2 hover:ring-border' : ''}
            `}
            {...attributes}
        >
            {/* Header - DRAG HANDLE */}
            <div
                className={`
                    flex items-center justify-between
                    px-3 py-2
                    bg-gradient-to-r ${colorClass}
                    rounded-t-xl
                    border-b-2 border-white/10
                    ${!isLocked ? 'cursor-move' : 'cursor-default'}
                `}
                {...listeners}
            >
                <div className="flex items-center gap-2">
                    <span className="text-base" role="img" aria-label={layer.type}>
                        {icon}
                    </span>
                    <span className="text-[10px] font-black text-white uppercase tracking-wider">
                        {layer.label || LAYER_TYPE_NAMES[layer.type]}
                    </span>
                </div>
                {isLocked && (
                    <Lock size={12} className="text-white/50" aria-label="Locked" />
                )}
            </div>

            {/* Body */}
            <div className="px-3 py-2 bg-card/80 backdrop-blur-sm">
                <p className="text-[9px] font-mono text-muted-foreground leading-relaxed">
                    {description}
                </p>
            </div>

            {/* Footer - Show parameter count or info */}
            <div className="px-3 py-1.5 bg-muted/20 rounded-b-xl border-t border-border/10">
                <p className="text-[7px] font-mono text-muted-foreground/60 uppercase tracking-widest text-center">
                    {getLayerFooter(layer)}
                </p>
            </div>

            {/* Action Buttons */}
            {!isLocked && (
                <div
                    className="
                        absolute -top-2 -right-2
                        opacity-0 group-hover:opacity-100
                        transition-opacity duration-200
                        flex gap-1
                    "
                >
                    {onSettings && (
                        <button
                            onClick={e => {
                                e.stopPropagation();
                                onSettings();
                            }}
                            className="
                                w-6 h-6 rounded-full
                                bg-muted hover:bg-muted/80
                                border border-border
                                flex items-center justify-center
                                transition-colors
                                shadow-md
                            "
                            aria-label="Settings"
                        >
                            <Settings size={12} className="text-foreground" />
                        </button>
                    )}
                    {onDelete && (
                        <button
                            onClick={e => {
                                e.stopPropagation();
                                onDelete();
                            }}
                            className="
                                w-6 h-6 rounded-full
                                bg-rose-500 hover:bg-rose-600
                                border border-rose-600
                                flex items-center justify-center
                                transition-colors
                                shadow-md
                            "
                            aria-label="Delete"
                        >
                            <Trash2 size={12} className="text-white" />
                        </button>
                    )}
                </div>
            )}

            {/* Connection Points */}
            {showConnectionPoints && (
                <>
                    {/* Input Connection Point */}
                    {layer.type !== LayerType.INPUT && (
                        <button
                            onClick={e => {
                                e.stopPropagation();
                                if (onInputClick) onInputClick();
                            }}
                            className="
                                absolute -left-2 top-1/2 -translate-y-1/2
                                w-4 h-4 rounded-full
                                bg-blue-500 border-2 border-white
                                shadow-lg
                                transition-all duration-200
                                hover:scale-125 hover:bg-blue-600
                                focus:outline-none focus:ring-2 focus:ring-blue-400
                            "
                            title="Input"
                            aria-label="Input connection point"
                        >
                            <Circle size={8} className="text-white absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" fill="currentColor" />
                        </button>
                    )}

                    {/* Output Connection Point */}
                    {layer.type !== LayerType.OUTPUT && (
                        <button
                            onClick={e => {
                                e.stopPropagation();
                                if (onOutputClick) onOutputClick();
                            }}
                            className="
                                absolute -right-2 top-1/2 -translate-y-1/2
                                w-4 h-4 rounded-full
                                bg-amber-500 border-2 border-white
                                shadow-lg
                                transition-all duration-200
                                hover:scale-125 hover:bg-amber-600
                                focus:outline-none focus:ring-2 focus:ring-amber-400
                            "
                            title="Output - Click to connect"
                            aria-label="Output connection point"
                        >
                            <Circle size={8} className="text-white absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" fill="currentColor" />
                        </button>
                    )}
                </>
            )}

            {/* Selection Indicator */}
            {isSelected && (
                <div className="absolute inset-0 rounded-xl border-2 border-cyan-500 pointer-events-none" />
            )}
        </div>
    );
};

// ─── Visual Helpers ─────────────────────────────────────────────────────────

/**
 * Gets emoji icon for layer type
 */
function getLayerIcon(type: LayerType): string {
    const icons: Record<LayerType, string> = {
        [LayerType.INPUT]: '📥',
        [LayerType.LINEAR]: '⚡',
        [LayerType.ACTIVATION]: '📊',
        [LayerType.DROPOUT]: '🎲',
        [LayerType.BATCHNORM]: '📏',
        [LayerType.RNN]: '🔄',
        [LayerType.GRU]: '🧠',
        [LayerType.OUTPUT]: '📤',
    };
    return icons[type] || '📦';
}

/**
 * Gets Tailwind gradient class for layer type
 */
function getLayerColorClass(type: LayerType): string {
    const colors: Record<LayerType, string> = {
        [LayerType.INPUT]: 'from-blue-500 to-blue-600',
        [LayerType.LINEAR]: 'from-cyan-500 to-cyan-600',
        [LayerType.ACTIVATION]: 'from-green-500 to-green-600',
        [LayerType.DROPOUT]: 'from-purple-500 to-purple-600',
        [LayerType.BATCHNORM]: 'from-indigo-500 to-indigo-600',
        [LayerType.RNN]: 'from-pink-500 to-pink-600',
        [LayerType.GRU]: 'from-rose-500 to-rose-600',
        [LayerType.OUTPUT]: 'from-amber-500 to-amber-600',
    };
    return colors[type] || 'from-gray-500 to-gray-600';
}

/**
 * Gets human-readable description of layer
 */
function getLayerDescription(layer: LayerConfig): string {
    if (isInputLayer(layer)) {
        return `Input (${layer.params.inputSize} features)`;
    }

    if (isLinearLayer(layer)) {
        return `Linear (${layer.params.inputSize} → ${layer.params.outputSize})`;
    }

    if (isActivationLayer(layer)) {
        const actName = ACTIVATION_TYPE_NAMES[layer.params.activationType] || layer.params.activationType;
        return `Activation (${actName})`;
    }

    if (isRNNLayer(layer)) {
        return `RNN (${layer.params.inputSize} → ${layer.params.hiddenSize})`;
    }

    if (isGRULayer(layer)) {
        return `GRU (${layer.params.inputSize} → ${layer.params.hiddenSize})`;
    }

    if (isOutputLayer(layer)) {
        return `Output (${layer.params.outputSize})`;
    }

    switch (layer.type) {
        case LayerType.DROPOUT:
            const dropoutRate = (layer.params as any).dropoutRate ?? 0.5;
            return `Dropout (${(dropoutRate * 100).toFixed(0)}%)`;

        case LayerType.BATCHNORM:
            const numFeatures = (layer.params as any).numFeatures ?? '?';
            return `Batch Norm (${numFeatures} features)`;

        default:
            return layer.type;
    }
}

/**
 * Gets footer text for layer
 */
function getLayerFooter(layer: LayerConfig): string {
    // Calculate approximate parameter count
    let paramCount = 0;

    if (isLinearLayer(layer)) {
        const { inputSize, outputSize, useBias = true } = layer.params;
        paramCount = inputSize * outputSize + (useBias ? outputSize : 0);
    } else if (isRNNLayer(layer) || isGRULayer(layer)) {
        const { inputSize, hiddenSize } = layer.params;
        // Simplified - actual RNN/GRU has more parameters
        paramCount = (inputSize + hiddenSize) * hiddenSize;
    }

    if (paramCount > 0) {
        return `${paramCount.toLocaleString()} params`;
    }

    return `Layer ID: ${layer.id.split('-')[0]}`;
}

// ─── Export ─────────────────────────────────────────────────────────────────

export default LayerNode;
