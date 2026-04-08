/**
 * NetworkCanvas Component
 *
 * Main canvas for the network builder. Handles rendering of layers,
 * connections, drag-and-drop, and user interactions.
 *
 * @module components/playground/v2/NetworkBuilder/NetworkCanvas
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
    DndContext,
    DragEndEvent,
    DragMoveEvent,
    DragStartEvent,
    MouseSensor,
    TouchSensor,
    useSensor,
    useSensors,
    DragOverlay,
} from '@dnd-kit/core';
import {
    LayerConfig,
    LayerConnection,
    Position,
    LayerType,
    DEFAULT_LAYER_PARAMS,
    ValidationMessage,
} from '@/types/network-builder';
import { UseNetworkGraphReturn } from '../shared/useNetworkGraph';
import { LayerNode } from './LayerNode';
import { Connection, ConnectionMarkers, TemporaryConnection, TemporaryConnectionMarker } from './Connection';
import { ZoomIn, ZoomOut, Maximize2, AlertCircle } from 'lucide-react';

// ─── Component Props ────────────────────────────────────────────────────────

interface NetworkCanvasProps {
    /** Network graph management hook */
    networkGraph: UseNetworkGraphReturn;
    /** Width of canvas in pixels */
    width?: number;
    /** Height of canvas in pixels */
    height?: number;
    /** Whether to show grid background */
    showGrid?: boolean;
    /** Callback when a layer is selected */
    onLayerSelect?: (layerId: string | null) => void;
    /** Callback when a connection is selected */
    onConnectionSelect?: (connectionId: string | null) => void;
}

// ─── Main Component ─────────────────────────────────────────────────────────

export const NetworkCanvas: React.FC<NetworkCanvasProps> = ({
    networkGraph,
    width = 1200,
    height = 800,
    showGrid = true,
    onLayerSelect,
    onConnectionSelect,
}) => {
    const canvasRef = useRef<HTMLDivElement>(null);
    const svgRef = useRef<SVGSVGElement>(null);

    // Selection state
    const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);

    // Connection drawing state
    const [drawingConnection, setDrawingConnection] = useState<{
        fromLayerId: string;
        currentPosition: Position;
    } | null>(null);

    // Drag state
    const [activeDragId, setActiveDragId] = useState<string | null>(null);

    // View state (zoom/pan)
    const [viewState, setViewState] = useState({
        zoom: 1,
        panX: 0,
        panY: 0,
    });

    // Setup drag sensors with minimal activation constraint for smooth dragging
    const sensors = useSensors(
        useSensor(MouseSensor, {
            activationConstraint: {
                distance: 2, // Reduced from 5px for smoother feel
            },
        }),
        useSensor(TouchSensor, {
            activationConstraint: {
                delay: 100,
                tolerance: 2,
            },
        })
    );

    // ─── Drag Handlers ──────────────────────────────────────────────────────

    const handleDragStart = useCallback((event: DragStartEvent) => {
        setActiveDragId(event.active.id as string);
    }, []);

    const handleDragMove = useCallback((event: DragMoveEvent) => {
        // Update visual feedback
    }, []);

    const handleDragEnd = useCallback(
        (event: DragEndEvent) => {
            setActiveDragId(null);

            const { active, delta } = event;
            const dragData = active.data.current;

            if (!dragData) return;

            // Handle dropping layer from palette
            if (dragData.type === 'palette_layer') {
                const layerType: LayerType = dragData.layerType;

                // Get drop position relative to canvas
                const rect = canvasRef.current?.getBoundingClientRect();
                if (!rect || !delta) return;

                // Calculate drop position: initial click position + drag delta
                const initialEvent = event.activatorEvent as MouseEvent;
                const initialX = initialEvent.clientX - rect.left;
                const initialY = initialEvent.clientY - rect.top;

                // Apply delta (simplified - no zoom/pan for now)
                const dropX = initialX + delta.x;
                const dropY = initialY + delta.y;

                // Create new layer
                const params = { ...DEFAULT_LAYER_PARAMS[layerType] };
                networkGraph.addLayer({
                    type: layerType,
                    position: { x: dropX, y: dropY },
                    params,
                });
            }

            // Handle moving existing layer
            else if (dragData.type === 'canvas_layer') {
                const layerId = dragData.layerId as string;
                const layer = networkGraph.graph.layers.find(l => l.id === layerId);

                if (layer && delta) {
                    networkGraph.moveLayer(layerId, {
                        x: layer.position.x + delta.x,
                        y: layer.position.y + delta.y,
                    });
                }
            }
        },
        [networkGraph]
    );

    // ─── Connection Handlers ────────────────────────────────────────────────

    const handleOutputClick = useCallback(
        (layerId: string) => {
            // Start drawing connection
            const layer = networkGraph.graph.layers.find(l => l.id === layerId);
            if (!layer) return;

            setDrawingConnection({
                fromLayerId: layerId,
                currentPosition: {
                    x: layer.position.x + 180, // NODE_WIDTH
                    y: layer.position.y + 40, // NODE_HEIGHT / 2
                },
            });
        },
        [networkGraph.graph.layers]
    );

    const handleInputClick = useCallback(
        (layerId: string) => {
            // Complete connection if we're drawing one
            if (drawingConnection) {
                networkGraph.addConnection({
                    from: drawingConnection.fromLayerId,
                    to: layerId,
                });
                setDrawingConnection(null);
            }
        },
        [drawingConnection, networkGraph]
    );

    const handleCanvasClick = useCallback(() => {
        // Clear selection and cancel connection drawing
        setSelectedLayerId(null);
        setSelectedConnectionId(null);
        setDrawingConnection(null);
        onLayerSelect?.(null);
        onConnectionSelect?.(null);
    }, [onLayerSelect, onConnectionSelect]);

    // Track mouse movement when drawing connection
    useEffect(() => {
        if (!drawingConnection) return;

        const handleMouseMove = (e: MouseEvent) => {
            const rect = canvasRef.current?.getBoundingClientRect();
            if (!rect) return;

            setDrawingConnection(prev =>
                prev
                    ? {
                          ...prev,
                          currentPosition: {
                              x: e.clientX - rect.left,
                              y: e.clientY - rect.top,
                          },
                      }
                    : null
            );
        };

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setDrawingConnection(null);
            }
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('keydown', handleKeyDown);

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [drawingConnection]);

    // ─── Zoom/Pan Controls ──────────────────────────────────────────────────

    const handleZoomIn = useCallback(() => {
        setViewState(prev => ({
            ...prev,
            zoom: Math.min(prev.zoom * 1.2, 3),
        }));
    }, []);

    const handleZoomOut = useCallback(() => {
        setViewState(prev => ({
            ...prev,
            zoom: Math.max(prev.zoom / 1.2, 0.3),
        }));
    }, []);

    const handleResetView = useCallback(() => {
        setViewState({ zoom: 1, panX: 0, panY: 0 });
    }, []);

    // ─── Validation Messages Display ────────────────────────────────────────

    const errorMessages = networkGraph.validationResult.messages.filter(
        m => m.severity === 'error'
    );

    const warningMessages = networkGraph.validationResult.messages.filter(
        m => m.severity === 'warning'
    );

    // ─── Render ─────────────────────────────────────────────────────────────

    return (
        <DndContext
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
        >
            <div className="relative w-full h-full flex flex-col bg-background rounded-2xl border border-border overflow-hidden shadow-2xl">
                {/* Toolbar */}
                <div className="flex items-center justify-between px-4 py-2 bg-card/80 border-b border-border backdrop-blur-sm">
                    <div className="flex items-center gap-4">
                        {/* Zoom Controls */}
                        <div className="flex items-center gap-1">
                            <button
                                onClick={handleZoomOut}
                                className="p-1.5 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
                                title="Zoom Out"
                            >
                                <ZoomOut size={14} />
                            </button>
                            <span className="text-[10px] font-mono text-muted-foreground min-w-[3rem] text-center">
                                {(viewState.zoom * 100).toFixed(0)}%
                            </span>
                            <button
                                onClick={handleZoomIn}
                                className="p-1.5 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
                                title="Zoom In"
                            >
                                <ZoomIn size={14} />
                            </button>
                            <button
                                onClick={handleResetView}
                                className="p-1.5 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
                                title="Reset View"
                            >
                                <Maximize2 size={14} />
                            </button>
                        </div>

                        {/* Stats */}
                        <div className="text-[9px] font-mono text-muted-foreground uppercase tracking-wider">
                            {networkGraph.graph.layers.length} Layers •{' '}
                            {networkGraph.graph.connections.length} Connections
                        </div>
                    </div>

                    {/* Validation Status */}
                    <div className="flex items-center gap-2">
                        {errorMessages.length > 0 && (
                            <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-rose-500/10 border border-rose-500/20">
                                <AlertCircle size={12} className="text-rose-500" />
                                <span className="text-[9px] font-bold text-rose-500">
                                    {errorMessages.length} Error{errorMessages.length !== 1 ? 's' : ''}
                                </span>
                            </div>
                        )}
                        {warningMessages.length > 0 && (
                            <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20">
                                <AlertCircle size={12} className="text-amber-500" />
                                <span className="text-[9px] font-bold text-amber-500">
                                    {warningMessages.length} Warning{warningMessages.length !== 1 ? 's' : ''}
                                </span>
                            </div>
                        )}
                        {networkGraph.isValid && (
                            <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                                <span className="text-[9px] font-bold text-emerald-500">✓ Valid</span>
                            </div>
                        )}
                    </div>
                </div>

                {/* Canvas */}
                <div
                    ref={canvasRef}
                    className={`
                        relative flex-1 overflow-hidden
                        ${showGrid ? 'bg-grid-pattern' : 'bg-muted/5'}
                    `}
                    onClick={handleCanvasClick}
                    style={{
                        backgroundSize: showGrid ? '20px 20px' : undefined,
                    }}
                >
                    {/* SVG Layer for Connections */}
                    <svg
                        ref={svgRef}
                        width={width}
                        height={height}
                        className="absolute inset-0 pointer-events-none"
                    >
                        <ConnectionMarkers />
                        <TemporaryConnectionMarker />

                        {/* Render connections */}
                        <g className="connections pointer-events-auto">
                            {networkGraph.graph.connections.map(conn => {
                                const fromLayer = networkGraph.graph.layers.find(l => l.id === conn.from);
                                const toLayer = networkGraph.graph.layers.find(l => l.id === conn.to);

                                if (!fromLayer || !toLayer) return null;

                                // Check if connection has validation errors
                                const hasError = networkGraph.validationResult.messages.some(
                                    m => m.connectionId === conn.id && m.severity === 'error'
                                );

                                return (
                                    <Connection
                                        key={conn.id}
                                        connection={conn}
                                        fromPosition={fromLayer.position}
                                        toPosition={toLayer.position}
                                        isSelected={selectedConnectionId === conn.id}
                                        hasError={hasError}
                                        onClick={() => {
                                            setSelectedConnectionId(conn.id);
                                            setSelectedLayerId(null);
                                            onConnectionSelect?.(conn.id);
                                        }}
                                        onDelete={() => networkGraph.removeConnection(conn.id)}
                                    />
                                );
                            })}
                        </g>

                        {/* Temporary connection while drawing */}
                        {drawingConnection && (
                            <TemporaryConnection
                                from={{
                                    x: drawingConnection.currentPosition.x,
                                    y: drawingConnection.currentPosition.y,
                                }}
                                to={drawingConnection.currentPosition}
                            />
                        )}
                    </svg>

                    {/* Layers */}
                    <div className="absolute inset-0">
                        {networkGraph.graph.layers.map(layer => (
                            <LayerNode
                                key={layer.id}
                                layer={layer}
                                isSelected={selectedLayerId === layer.id}
                                isLocked={layer.locked}
                                onClick={() => {
                                    setSelectedLayerId(layer.id);
                                    setSelectedConnectionId(null);
                                    onLayerSelect?.(layer.id);
                                }}
                                onDelete={() => networkGraph.removeLayer(layer.id)}
                                onOutputClick={() => handleOutputClick(layer.id)}
                                onInputClick={() => handleInputClick(layer.id)}
                            />
                        ))}
                    </div>

                    {/* Empty State */}
                    {networkGraph.graph.layers.length === 0 && (
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                            <div className="text-center space-y-2">
                                <p className="text-sm font-medium text-muted-foreground">
                                    Drag layers from the palette to start building
                                </p>
                                <p className="text-xs text-muted-foreground/60">
                                    Connect layers by clicking output points
                                </p>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Drag Overlay */}
            <DragOverlay>
                {activeDragId && activeDragId.startsWith('palette-') && (
                    <div className="p-2 rounded-lg bg-card border-2 border-cyan-500 shadow-2xl opacity-80">
                        <span className="text-xs font-bold">
                            {activeDragId.replace('palette-', '')}
                        </span>
                    </div>
                )}
            </DragOverlay>
        </DndContext>
    );
};

// ─── Export ─────────────────────────────────────────────────────────────────

export default NetworkCanvas;
