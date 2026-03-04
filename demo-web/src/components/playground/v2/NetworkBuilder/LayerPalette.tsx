/**
 * LayerPalette Component
 *
 * Displays available layer types that can be dragged onto the canvas.
 * Organized by category with descriptions and icons.
 *
 * @module components/playground/v2/NetworkBuilder/LayerPalette
 */

import React, { useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import {
    LayerType,
    LAYER_TYPE_NAMES,
    DragItemType,
} from '@/types/network-builder';
import { Layers, ChevronDown, ChevronRight, Info } from 'lucide-react';

// ─── Component Props ────────────────────────────────────────────────────────

interface LayerPaletteProps {
    /** Callback when a layer type is selected (alternative to drag-and-drop) */
    onLayerSelect?: (layerType: LayerType) => void;
    /** Whether to show advanced layers (RNN, GRU, etc.) */
    showAdvanced?: boolean;
}

// ─── Layer Categories ───────────────────────────────────────────────────────

interface LayerCategory {
    name: string;
    description: string;
    layers: LayerType[];
    defaultExpanded: boolean;
}

const LAYER_CATEGORIES: LayerCategory[] = [
    {
        name: 'Input/Output',
        description: 'Network boundaries',
        layers: [LayerType.INPUT, LayerType.OUTPUT],
        defaultExpanded: true,
    },
    {
        name: 'Core',
        description: 'Essential transformations',
        layers: [LayerType.LINEAR, LayerType.ACTIVATION],
        defaultExpanded: true,
    },
    {
        name: 'Regularization',
        description: 'Prevent overfitting',
        layers: [LayerType.DROPOUT, LayerType.BATCHNORM],
        defaultExpanded: false,
    },
    {
        name: 'Temporal',
        description: 'Sequential data processing',
        layers: [LayerType.RNN, LayerType.GRU],
        defaultExpanded: false,
    },
];

// ─── Main Component ─────────────────────────────────────────────────────────

export const LayerPalette: React.FC<LayerPaletteProps> = ({
    onLayerSelect,
    showAdvanced = true,
}) => {
    const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
        new Set(
            LAYER_CATEGORIES.filter(c => c.defaultExpanded).map(c => c.name)
        )
    );

    const toggleCategory = (categoryName: string) => {
        setExpandedCategories(prev => {
            const next = new Set(prev);
            if (next.has(categoryName)) {
                next.delete(categoryName);
            } else {
                next.add(categoryName);
            }
            return next;
        });
    };

    // Filter categories based on showAdvanced
    const visibleCategories = showAdvanced
        ? LAYER_CATEGORIES
        : LAYER_CATEGORIES.filter(c => c.name !== 'Temporal');

    return (
        <div className="w-full max-w-sm bg-card/50 border border-border rounded-2xl overflow-hidden backdrop-blur-md shadow-xl">
            {/* Header */}
            <div className="p-4 border-b border-border bg-card/80 flex items-center justify-between">
                <div className="flex flex-col">
                    <h3 className="text-sm font-bold text-foreground uppercase tracking-tighter flex items-center gap-2">
                        <Layers size={14} className="text-cyan-500" />
                        Layer Palette
                    </h3>
                    <p className="text-[9px] text-muted-foreground font-mono mt-0.5 uppercase">
                        Drag to canvas
                    </p>
                </div>
            </div>

            {/* Categories */}
            <div className="p-3 space-y-3 max-h-[600px] overflow-y-auto custom-scrollbar">
                {visibleCategories.map(category => {
                    const isExpanded = expandedCategories.has(category.name);

                    return (
                        <div key={category.name} className="space-y-2">
                            {/* Category Header */}
                            <button
                                onClick={() => toggleCategory(category.name)}
                                className="
                                    w-full flex items-center justify-between
                                    px-2 py-1.5 rounded-lg
                                    bg-muted/30 hover:bg-muted/50
                                    transition-colors
                                    group
                                "
                            >
                                <div className="flex items-center gap-2">
                                    {isExpanded ? (
                                        <ChevronDown size={12} className="text-muted-foreground" />
                                    ) : (
                                        <ChevronRight size={12} className="text-muted-foreground" />
                                    )}
                                    <span className="text-[10px] font-bold text-foreground uppercase tracking-wider">
                                        {category.name}
                                    </span>
                                </div>
                                <span className="text-[8px] text-muted-foreground font-mono opacity-0 group-hover:opacity-100 transition-opacity">
                                    {category.description}
                                </span>
                            </button>

                            {/* Category Layers */}
                            {isExpanded && (
                                <div className="space-y-1.5 pl-2">
                                    {category.layers.map(layerType => (
                                        <PaletteLayerItem
                                            key={layerType}
                                            layerType={layerType}
                                            onClick={() => onLayerSelect?.(layerType)}
                                        />
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* Footer Hint */}
            <div className="p-3 bg-muted/20 border-t border-border">
                <div className="flex items-start gap-2 text-[8px] text-muted-foreground">
                    <Info size={12} className="flex-shrink-0 mt-0.5" />
                    <p className="leading-relaxed">
                        <span className="font-bold">Tip:</span> Drag layers onto the canvas or click to add at center.
                        Connect layers by clicking output points.
                    </p>
                </div>
            </div>
        </div>
    );
};

// ─── Palette Layer Item ─────────────────────────────────────────────────────

interface PaletteLayerItemProps {
    layerType: LayerType;
    onClick?: () => void;
}

const PaletteLayerItem: React.FC<PaletteLayerItemProps> = ({ layerType, onClick }) => {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
        id: `palette-${layerType}`,
        data: {
            type: DragItemType.PALETTE_LAYER,
            layerType,
        },
    });

    const icon = getLayerIcon(layerType);
    const color = getLayerColor(layerType);
    const description = getLayerDescription(layerType);

    return (
        <div
            ref={setNodeRef}
            {...attributes}
            {...listeners}
            onClick={onClick}
            className={`
                relative px-3 py-2 rounded-lg
                bg-card border border-border/50
                hover:border-border hover:shadow-md
                transition-all duration-200
                cursor-move active:cursor-grabbing
                ${isDragging ? 'opacity-50 scale-95' : 'hover:scale-[1.02]'}
            `}
        >
            <div className="flex items-center gap-3">
                {/* Icon */}
                <div
                    className={`
                        w-8 h-8 rounded-lg
                        bg-gradient-to-br ${color}
                        flex items-center justify-center
                        text-base shadow-sm
                    `}
                >
                    {icon}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                    <h4 className="text-[10px] font-bold text-foreground uppercase tracking-wider truncate">
                        {LAYER_TYPE_NAMES[layerType]}
                    </h4>
                    <p className="text-[8px] text-muted-foreground font-mono truncate">
                        {description}
                    </p>
                </div>
            </div>

            {/* Drag indicator */}
            {!isDragging && (
                <div className="
                    absolute top-1 right-1
                    opacity-0 group-hover:opacity-50
                    transition-opacity
                ">
                    <div className="flex flex-col gap-0.5">
                        <div className="w-1 h-1 rounded-full bg-muted-foreground" />
                        <div className="w-1 h-1 rounded-full bg-muted-foreground" />
                        <div className="w-1 h-1 rounded-full bg-muted-foreground" />
                    </div>
                </div>
            )}
        </div>
    );
};

// ─── Visual Helpers ─────────────────────────────────────────────────────────

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

function getLayerColor(type: LayerType): string {
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

function getLayerDescription(type: LayerType): string {
    const descriptions: Record<LayerType, string> = {
        [LayerType.INPUT]: 'Network input',
        [LayerType.LINEAR]: 'Fully connected',
        [LayerType.ACTIVATION]: 'Non-linearity',
        [LayerType.DROPOUT]: 'Random masking',
        [LayerType.BATCHNORM]: 'Normalize features',
        [LayerType.RNN]: 'Recurrent unit',
        [LayerType.GRU]: 'Gated recurrent',
        [LayerType.OUTPUT]: 'Network output',
    };
    return descriptions[type] || type;
}

// ─── Export ─────────────────────────────────────────────────────────────────

export default LayerPalette;
