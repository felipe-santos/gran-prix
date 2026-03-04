/**
 * Connection Component
 *
 * Visual representation of a connection between two layers.
 * Renders as an SVG path with arrowhead and hover effects.
 *
 * @module components/playground/v2/NetworkBuilder/Connection
 */

import React, { useMemo } from 'react';
import { LayerConnection, Position } from '@/types/network-builder';

// ─── Component Props ────────────────────────────────────────────────────────

interface ConnectionProps {
    /** Connection configuration */
    connection: LayerConnection;
    /** Position of source layer */
    fromPosition: Position;
    /** Position of target layer */
    toPosition: Position;
    /** Whether this connection is selected */
    isSelected?: boolean;
    /** Whether this connection has an error (dimension mismatch, etc.) */
    hasError?: boolean;
    /** Whether to animate the connection */
    animated?: boolean;
    /** Callback when connection is clicked */
    onClick?: () => void;
    /** Callback when delete is requested */
    onDelete?: () => void;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Standard node width for calculating connection points */
const NODE_WIDTH = 180;
/** Standard node height for calculating connection points */
const NODE_HEIGHT = 80;

// ─── Main Component ─────────────────────────────────────────────────────────

export const Connection: React.FC<ConnectionProps> = ({
    connection,
    fromPosition,
    toPosition,
    isSelected = false,
    hasError = false,
    animated = false,
    onClick,
    onDelete,
}) => {
    // Calculate start and end points (right side of from node, left side of to node)
    const startX = fromPosition.x + NODE_WIDTH;
    const startY = fromPosition.y + NODE_HEIGHT / 2;
    const endX = toPosition.x;
    const endY = toPosition.y + NODE_HEIGHT / 2;

    // Calculate control points for cubic Bezier curve
    const { path, midPoint } = useMemo(() => {
        return calculatePath(startX, startY, endX, endY);
    }, [startX, startY, endX, endY]);

    // Determine stroke color
    const strokeColor = hasError
        ? 'rgb(239 68 68)' // red-500
        : isSelected
        ? 'rgb(6 182 212)' // cyan-500
        : 'rgb(148 163 184)'; // slate-400

    const strokeOpacity = isSelected ? 0.8 : hasError ? 0.6 : 0.4;
    const strokeWidth = isSelected ? 3 : hasError ? 2.5 : 2;

    return (
        <g
            className="connection-group cursor-pointer transition-all duration-200"
            onClick={onClick}
        >
            {/* Invisible wider path for easier clicking */}
            <path
                d={path}
                stroke="transparent"
                strokeWidth={20}
                fill="none"
                className="pointer-events-auto"
            />

            {/* Main path */}
            <path
                d={path}
                stroke={strokeColor}
                strokeWidth={strokeWidth}
                strokeOpacity={strokeOpacity}
                fill="none"
                markerEnd={`url(#arrowhead-${isSelected ? 'selected' : hasError ? 'error' : 'normal'})`}
                className="transition-all duration-200"
                strokeDasharray={animated ? '5,5' : undefined}
            >
                {animated && (
                    <animate
                        attributeName="stroke-dashoffset"
                        from="0"
                        to="10"
                        dur="0.5s"
                        repeatCount="indefinite"
                    />
                )}
            </path>

            {/* Hover/Selected indicator circle at midpoint */}
            {(isSelected || hasError) && (
                <circle
                    cx={midPoint.x}
                    cy={midPoint.y}
                    r={4}
                    fill={hasError ? 'rgb(239 68 68)' : 'rgb(6 182 212)'}
                    opacity={0.8}
                    className="animate-pulse"
                />
            )}

            {/* Delete button (only on hover if onDelete provided) */}
            {onDelete && isSelected && (
                <g
                    className="delete-button"
                    onClick={e => {
                        e.stopPropagation();
                        onDelete();
                    }}
                >
                    <circle
                        cx={midPoint.x}
                        cy={midPoint.y}
                        r={10}
                        fill="rgb(239 68 68)"
                        className="cursor-pointer hover:fill-red-600 transition-colors"
                    />
                    <text
                        x={midPoint.x}
                        y={midPoint.y}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fill="white"
                        fontSize="12"
                        fontWeight="bold"
                        className="pointer-events-none select-none"
                    >
                        ×
                    </text>
                </g>
            )}
        </g>
    );
};

// ─── SVG Marker Definitions ────────────────────────────────────────────────

/**
 * Arrow marker definitions for connections
 * Should be added to the SVG <defs> element
 */
export const ConnectionMarkers: React.FC = () => (
    <defs>
        {/* Normal arrowhead */}
        <marker
            id="arrowhead-normal"
            markerWidth="10"
            markerHeight="10"
            refX="9"
            refY="3"
            orient="auto"
            markerUnits="strokeWidth"
        >
            <path d="M0,0 L0,6 L9,3 z" fill="rgb(148 163 184)" opacity="0.4" />
        </marker>

        {/* Selected arrowhead */}
        <marker
            id="arrowhead-selected"
            markerWidth="10"
            markerHeight="10"
            refX="9"
            refY="3"
            orient="auto"
            markerUnits="strokeWidth"
        >
            <path d="M0,0 L0,6 L9,3 z" fill="rgb(6 182 212)" opacity="0.8" />
        </marker>

        {/* Error arrowhead */}
        <marker
            id="arrowhead-error"
            markerWidth="10"
            markerHeight="10"
            refX="9"
            refY="3"
            orient="auto"
            markerUnits="strokeWidth"
        >
            <path d="M0,0 L0,6 L9,3 z" fill="rgb(239 68 68)" opacity="0.6" />
        </marker>
    </defs>
);

// ─── Path Calculation ───────────────────────────────────────────────────────

/**
 * Calculates a smooth cubic Bezier path between two points
 *
 * @param x1 - Start X
 * @param y1 - Start Y
 * @param x2 - End X
 * @param y2 - End Y
 * @returns Path string and midpoint
 */
function calculatePath(
    x1: number,
    y1: number,
    x2: number,
    y2: number
): { path: string; midPoint: Position } {
    // Calculate control point offset based on distance
    const dx = x2 - x1;
    const dy = y2 - y1;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Control point offset is proportional to distance
    const offset = Math.min(distance * 0.5, 200);

    // Control points for cubic Bezier
    const cx1 = x1 + offset;
    const cy1 = y1;
    const cx2 = x2 - offset;
    const cy2 = y2;

    // Build SVG path
    const path = `M ${x1},${y1} C ${cx1},${cy1} ${cx2},${cy2} ${x2},${y2}`;

    // Calculate approximate midpoint on cubic Bezier (t=0.5)
    const t = 0.5;
    const mt = 1 - t;
    const midX =
        mt * mt * mt * x1 +
        3 * mt * mt * t * cx1 +
        3 * mt * t * t * cx2 +
        t * t * t * x2;
    const midY =
        mt * mt * mt * y1 +
        3 * mt * mt * t * cy1 +
        3 * mt * t * t * cy2 +
        t * t * t * y2;

    return {
        path,
        midPoint: { x: midX, y: midY },
    };
}

// ─── Temporary Connection (While Drawing) ──────────────────────────────────

interface TemporaryConnectionProps {
    /** Starting position */
    from: Position;
    /** Current mouse position */
    to: Position;
}

/**
 * Visual feedback while user is drawing a new connection
 */
export const TemporaryConnection: React.FC<TemporaryConnectionProps> = ({ from, to }) => {
    const { path } = useMemo(() => {
        return calculatePath(from.x, from.y, to.x, to.y);
    }, [from, to]);

    return (
        <g className="temporary-connection">
            <path
                d={path}
                stroke="rgb(6 182 212)"
                strokeWidth={2}
                strokeOpacity={0.5}
                fill="none"
                strokeDasharray="5,5"
                markerEnd="url(#arrowhead-temp)"
            />

            {/* Animated cursor circle */}
            <circle cx={to.x} cy={to.y} r={6} fill="rgb(6 182 212)" opacity={0.6}>
                <animate
                    attributeName="r"
                    values="6;8;6"
                    dur="1s"
                    repeatCount="indefinite"
                />
            </circle>
        </g>
    );
};

/**
 * Marker for temporary connections
 */
export const TemporaryConnectionMarker: React.FC = () => (
    <marker
        id="arrowhead-temp"
        markerWidth="10"
        markerHeight="10"
        refX="9"
        refY="3"
        orient="auto"
        markerUnits="strokeWidth"
    >
        <path d="M0,0 L0,6 L9,3 z" fill="rgb(6 182 212)" opacity="0.5" />
    </marker>
);

// ─── Export ─────────────────────────────────────────────────────────────────

export default Connection;
