/**
 * NetworkBuilder Component
 *
 * Main container for the neural network builder.
 * Integrates canvas, palette, controls, and template library.
 *
 * @module components/playground/v2/NetworkBuilder/NetworkBuilder
 */

import React, { useState, useCallback, useEffect } from 'react';
import { useNetworkGraph } from '../shared/useNetworkGraph';
import { NetworkCanvas } from './NetworkCanvas';
import { LayerPalette } from './LayerPalette';
import { TemplateLibrary } from '../Templates/TemplateLibrary';
import {
    serializeNetworkForWasm,
    checkWasmCompatibility,
    SerializationError,
} from './NetworkSerializer';
import {
    NetworkTemplate,
    LayerType,
    DEFAULT_LAYER_PARAMS,
    ValidationMessage,
} from '@/types/network-builder';
import {
    Download,
    Upload,
    Trash2,
    Library,
    Code,
    Play,
    AlertCircle,
    Info,
    Undo,
    Redo,
    Settings,
} from 'lucide-react';

// ─── Component Props ────────────────────────────────────────────────────────

interface NetworkBuilderProps {
    /** Callback when ready to train (receives WASM config) */
    onTrain?: (config: any) => void;
    /** Initial network to load */
    initialNetwork?: NetworkTemplate;
    /** Whether to show advanced features */
    showAdvanced?: boolean;
}

// ─── Main Component ─────────────────────────────────────────────────────────

export const NetworkBuilder: React.FC<NetworkBuilderProps> = ({
    onTrain,
    initialNetwork,
    showAdvanced = true,
}) => {
    // Network state
    const networkGraph = useNetworkGraph({
        initialGraph: initialNetwork?.graph,
        onChange: graph => {
            console.log('[NetworkBuilder] Graph changed:', graph);
        },
    });

    // UI state
    const [showTemplates, setShowTemplates] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [compatibilityIssues, setCompatibilityIssues] = useState<string[]>([]);

    // Check WASM compatibility whenever graph changes
    useEffect(() => {
        const issues = checkWasmCompatibility(networkGraph.graph);
        setCompatibilityIssues(issues);
    }, [networkGraph.graph]);

    // ─── Handlers ───────────────────────────────────────────────────────────

    const handleTemplateSelect = useCallback(
        (template: NetworkTemplate) => {
            networkGraph.loadTemplate(template);
            setShowTemplates(false);
        },
        [networkGraph]
    );

    const handleLayerSelect = useCallback(
        (layerType: LayerType) => {
            // Add layer at center of canvas
            const params = { ...DEFAULT_LAYER_PARAMS[layerType] };
            networkGraph.addLayer({
                type: layerType,
                position: { x: 400, y: 300 },
                params,
            });
        },
        [networkGraph]
    );

    const handleExportJSON = useCallback(() => {
        const json = JSON.stringify(networkGraph.graph, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `network-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }, [networkGraph.graph]);

    const handleImportJSON = useCallback(
        async (file: File) => {
            try {
                const text = await file.text();
                const graph = JSON.parse(text);
                networkGraph.loadTemplate({ id: 'imported', name: 'Imported', description: '', category: 'custom', graph });
            } catch (err) {
                console.error('Import failed:', err);
                alert('Failed to import network JSON');
            }
        },
        [networkGraph]
    );

    const handleTrain = useCallback(() => {
        try {
            const wasmConfig = serializeNetworkForWasm(networkGraph.graph);
            console.log('[NetworkBuilder] WASM Config:', wasmConfig);
            if (onTrain) {
                onTrain(wasmConfig);
            } else {
                alert('Training callback not provided');
            }
        } catch (err) {
            if (err instanceof SerializationError) {
                alert(`Cannot train: ${err.message}`);
            } else {
                console.error('Serialization error:', err);
                alert('Failed to prepare network for training');
            }
        }
    }, [networkGraph.graph, onTrain]);

    // Get validation messages
    const errorMessages = networkGraph.validationResult.messages.filter(
        m => m.severity === 'error'
    );

    const warningMessages = networkGraph.validationResult.messages.filter(
        m => m.severity === 'warning'
    );

    const canTrain = networkGraph.isValid && compatibilityIssues.length === 0;

    // ─── Render ─────────────────────────────────────────────────────────────

    return (
        <div className="w-full h-screen flex flex-col bg-background">
            {/* Top Toolbar */}
            <div className="flex items-center justify-between px-6 py-4 bg-card/80 border-b border-border backdrop-blur-sm">
                <div className="flex items-center gap-4">
                    <h1 className="text-lg font-black bg-gradient-to-br from-cyan-400 to-blue-600 bg-clip-text text-transparent uppercase tracking-[0.3em]">
                        Network Builder
                    </h1>
                    <div className="w-px h-6 bg-border" />
                    <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">
                        {networkGraph.graph.metadata.name}
                    </span>
                </div>

                <div className="flex items-center gap-2">
                    {/* Undo/Redo */}
                    <button
                        onClick={networkGraph.undo}
                        disabled={!networkGraph.canUndo}
                        className="p-2 rounded-lg hover:bg-muted/50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        title="Undo"
                    >
                        <Undo size={16} />
                    </button>
                    <button
                        onClick={networkGraph.redo}
                        disabled={!networkGraph.canRedo}
                        className="p-2 rounded-lg hover:bg-muted/50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        title="Redo"
                    >
                        <Redo size={16} />
                    </button>

                    <div className="w-px h-6 bg-border" />

                    {/* Actions */}
                    <button
                        onClick={() => setShowTemplates(true)}
                        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-purple-500/10 border border-purple-500/20 hover:bg-purple-500/20 transition-colors"
                    >
                        <Library size={14} className="text-purple-400" />
                        <span className="text-xs font-bold text-purple-400">Templates</span>
                    </button>

                    <button
                        onClick={handleExportJSON}
                        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/50 border border-border hover:bg-muted transition-colors"
                        title="Export as JSON"
                    >
                        <Download size={14} />
                    </button>

                    <label className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/50 border border-border hover:bg-muted transition-colors cursor-pointer">
                        <Upload size={14} />
                        <input
                            type="file"
                            accept=".json"
                            className="hidden"
                            onChange={e => {
                                const file = e.target.files?.[0];
                                if (file) handleImportJSON(file);
                            }}
                        />
                    </label>

                    <button
                        onClick={() => {
                            if (confirm('Clear entire network?')) {
                                networkGraph.clearGraph();
                            }
                        }}
                        className="p-2 rounded-lg hover:bg-rose-500/10 text-rose-500 transition-colors"
                        title="Clear Network"
                    >
                        <Trash2 size={14} />
                    </button>

                    <div className="w-px h-6 bg-border" />

                    {/* Train Button */}
                    <button
                        onClick={handleTrain}
                        disabled={!canTrain}
                        className={`
                            flex items-center gap-2 px-4 py-2 rounded-lg font-bold text-sm
                            transition-all
                            ${
                                canTrain
                                    ? 'bg-gradient-to-r from-emerald-500 to-green-500 hover:from-emerald-600 hover:to-green-600 text-white shadow-lg'
                                    : 'bg-muted/50 text-muted-foreground cursor-not-allowed'
                            }
                        `}
                    >
                        <Play size={14} fill="currentColor" />
                        <span>Start Training</span>
                    </button>
                </div>
            </div>

            {/* Main Content */}
            <div className="flex-1 flex overflow-hidden">
                {/* Left Sidebar - Layer Palette */}
                <div className="w-80 flex-shrink-0 p-4 border-r border-border overflow-y-auto custom-scrollbar">
                    <LayerPalette
                        onLayerSelect={handleLayerSelect}
                        showAdvanced={showAdvanced}
                    />

                    {/* Validation Messages */}
                    {(errorMessages.length > 0 || warningMessages.length > 0 || compatibilityIssues.length > 0) && (
                        <div className="mt-4 space-y-2">
                            {errorMessages.length > 0 && (
                                <ValidationMessagesList
                                    title="Errors"
                                    messages={errorMessages}
                                    severity="error"
                                />
                            )}
                            {warningMessages.length > 0 && (
                                <ValidationMessagesList
                                    title="Warnings"
                                    messages={warningMessages}
                                    severity="warning"
                                />
                            )}
                            {compatibilityIssues.length > 0 && (
                                <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                                    <div className="flex items-center gap-2 mb-2">
                                        <AlertCircle size={14} className="text-amber-500" />
                                        <h4 className="text-[10px] font-bold text-amber-500 uppercase">
                                            WASM Compatibility
                                        </h4>
                                    </div>
                                    <ul className="space-y-1">
                                        {compatibilityIssues.map((issue, i) => (
                                            <li key={i} className="text-[9px] text-amber-400/80 leading-relaxed">
                                                • {issue}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Center - Network Canvas */}
                <div className="flex-1 p-4">
                    <NetworkCanvas
                        networkGraph={networkGraph}
                        width={1200}
                        height={800}
                        showGrid={true}
                    />
                </div>
            </div>

            {/* Template Library Modal */}
            {showTemplates && (
                <TemplateLibrary
                    onTemplateSelect={handleTemplateSelect}
                    onClose={() => setShowTemplates(false)}
                    modal={true}
                />
            )}
        </div>
    );
};

// ─── Validation Messages List ───────────────────────────────────────────────

interface ValidationMessagesListProps {
    title: string;
    messages: ValidationMessage[];
    severity: 'error' | 'warning' | 'info';
}

const ValidationMessagesList: React.FC<ValidationMessagesListProps> = ({
    title,
    messages,
    severity,
}) => {
    const colors = {
        error: 'rose',
        warning: 'amber',
        info: 'blue',
    };

    const color = colors[severity];

    return (
        <div className={`p-3 bg-${color}-500/10 border border-${color}-500/20 rounded-lg`}>
            <div className="flex items-center gap-2 mb-2">
                <AlertCircle size={14} className={`text-${color}-500`} />
                <h4 className={`text-[10px] font-bold text-${color}-500 uppercase`}>
                    {title}
                </h4>
            </div>
            <ul className="space-y-1">
                {messages.map((msg, i) => (
                    <li key={i} className={`text-[9px] text-${color}-400/80 leading-relaxed`}>
                        • {msg.message}
                        {msg.suggestion && (
                            <span className="block text-[8px] ml-3 mt-0.5 opacity-70">
                                💡 {msg.suggestion}
                            </span>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
};

// ─── Export ─────────────────────────────────────────────────────────────────

export default NetworkBuilder;
