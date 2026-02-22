import React, { useState, useEffect, useRef } from 'react';
import * as wasm from '../../wasm/pkg/gran_prix_wasm';

// Components
import { PlaygroundCanvas, DataPoint } from './PlaygroundCanvas';
import { PlaygroundControls } from './PlaygroundControls';
import { WeightsViewer } from './WeightsViewer';
import { PlaygroundExplanation } from './PlaygroundExplanation';
import { PRESETS } from './PlaygroundPresets';
import { generateCCode } from './exportCode';
import { FeatureType, expandFeatures } from './features';

export const NeuralPlayground: React.FC = () => {
    // WASM Init State
    const trainerRef = useRef<wasm.Trainer | null>(null);
    const [isWasmReady, setIsWasmReady] = useState(false);

    // Application State
    const [points, setPoints] = useState<DataPoint[]>([]);
    const [currentLabel, setCurrentLabel] = useState<number>(0);
    const [isTraining, setIsTraining] = useState(false);
    const [learningRate, setLearningRate] = useState<number>(0.03);
    const [loss, setLoss] = useState<number>(0);
    const [weights, setWeights] = useState<Float32Array | null>(null);
    const [decisionBoundary, setDecisionBoundary] = useState<number[]>([]);
    const [hiddenLayers, setHiddenLayers] = useState<number[]>([4, 4]);
    const [activeFeatures, setActiveFeatures] = useState<FeatureType[]>(['x', 'y']);
    const [currentPresetId, setCurrentPresetId] = useState<string | null>(null);

    // Config
    const RESOLUTION = 40;

    // 1. Initialize WASM
    useEffect(() => {
        let mounted = true;
        const init = async () => {
            try {
                await wasm.default();
                if (mounted) {
                    // Pass input_dim (activeFeatures.length) and hidden_layers
                    const t = new wasm.Trainer(activeFeatures.length, new Uint32Array(hiddenLayers));
                    trainerRef.current = t;
                    setIsWasmReady(true);

                    const initWeights = t.get_weights();
                    setWeights(initWeights);
                    const featureMap = (x: number, y: number) => expandFeatures(x, y, activeFeatures);
                    setDecisionBoundary(Array.from(t.get_decision_boundary(RESOLUTION, featureMap)));
                }
            } catch (err) {
                console.error("Failed to initialize WASM Trainer", err);
            }
        };
        init();
        return () => {
            mounted = false;
            if (trainerRef.current) trainerRef.current.free();
            trainerRef.current = null;
        };
    }, [hiddenLayers, activeFeatures]);

    // 2. Training Loop
    useEffect(() => {
        if (!isTraining || !isWasmReady || !trainerRef.current || points.length === 0) return;

        let frameId: number;
        const train = () => {
            if (!trainerRef.current) return;

            const batchSize = Math.min(points.length, 10);
            const batchInputs = new Float32Array(batchSize * activeFeatures.length);
            const batchTargets = new Float32Array(batchSize);

            for (let i = 0; i < batchSize; i++) {
                const pt = points[Math.floor(Math.random() * points.length)];
                const expanded = expandFeatures(pt.x, pt.y, activeFeatures);
                batchInputs.set(expanded, i * activeFeatures.length);
                batchTargets[i] = pt.label;
            }

            try {
                const currentLoss = trainerRef.current.train_batch(batchInputs, batchTargets, learningRate);
                setLoss(currentLoss);

                const currentWeights = trainerRef.current.get_weights();
                setWeights(currentWeights);

                // DIAGNOSTIC: Log gradient engagement periodically
                if (Math.random() < 0.01) { // ~Every 100 frames
                    const gradNorms = trainerRef.current.get_gradient_norms();
                    console.log("[PRIX_DIAG] Gradient Abs-Sum per Parameter Block (W1, B1, W2, B2...):");
                    console.log(Array.from(gradNorms).map((n, i) => `Block ${i}: ${n.toFixed(6)}`).join(" | "));
                }

                const featureMap = (x: number, y: number) => expandFeatures(x, y, activeFeatures);
                setDecisionBoundary(Array.from(trainerRef.current.get_decision_boundary(RESOLUTION, featureMap)));
            } catch (e) {
                console.error("Training error:", e);
            }

            frameId = requestAnimationFrame(train);
        };

        frameId = requestAnimationFrame(train);
        return () => cancelAnimationFrame(frameId);
    }, [isTraining, isWasmReady, points, learningRate, activeFeatures]);

    // 3. Handlers
    const handleCanvasClick = (x: number, y: number) => {
        setPoints(prev => [...prev, { x, y, label: currentLabel }]);
        setCurrentPresetId(null);
    };

    const handleClear = () => {
        setPoints([]);
        setIsTraining(false);
        setLoss(0);
    };

    const handleExport = () => {
        if (!weights) return;
        const blob = new Blob([JSON.stringify(Array.from(weights))], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'brain_weights.json';
        a.click();
    };

    const handleExportCCode = () => {
        if (!weights) return;
        const code = generateCCode(weights, hiddenLayers, activeFeatures);
        const blob = new Blob([code], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'neural_core.h';
        a.click();
    };

    const handleImport = async (file: File) => {
        if (!trainerRef.current) return;
        try {
            const text = await file.text();
            const arr = JSON.parse(text);
            if (!Array.isArray(arr)) throw new Error("Invalid format");
            const floatArr = new Float32Array(arr);

            trainerRef.current.import_weights(floatArr);
            setWeights(trainerRef.current.get_weights());
            const featureMap = (x: number, y: number) => expandFeatures(x, y, activeFeatures);
            setDecisionBoundary(Array.from(trainerRef.current.get_decision_boundary(RESOLUTION, featureMap)));
            setIsTraining(false);
        } catch (err) {
            console.error("Import failed:", err);
            alert("Failed to import weights JSON file.");
        }
    };

    const handleAddLayer = () => {
        setHiddenLayers(prev => [...prev, 4]);
    };

    const handleRemoveLayer = (index: number) => {
        setHiddenLayers(prev => prev.filter((_, i) => i !== index));
    };

    const handleUpdateNeurons = (index: number, delta: number) => {
        const next = [...hiddenLayers];
        next[index] = Math.max(1, Math.min(64, next[index] + delta));
        setHiddenLayers(next);
    };

    const handleToggleFeature = (feat: FeatureType) => {
        if (activeFeatures.includes(feat)) {
            if (activeFeatures.length > 1) {
                setActiveFeatures(activeFeatures.filter(f => f !== feat));
            }
        } else {
            setActiveFeatures([...activeFeatures, feat]);
        }
    };

    const handleExportDataset = () => {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(points));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", "gran_prix_dataset.json");
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
    };

    const handleImportDataset = async (file: File) => {
        try {
            const text = await file.text();
            let newPoints: DataPoint[] = [];

            if (file.name.endsWith('.csv')) {
                const lines = text.split('\n').filter(l => l.trim());
                // Simple CSV parser: x,y,label (optionally with header)
                const startIdx = isNaN(parseFloat(lines[0].split(',')[0])) ? 1 : 0;

                const rawPoints = lines.slice(startIdx).map(line => {
                    const [x, y, label] = line.split(',').map(v => parseFloat(v));
                    return { x: isNaN(x) ? 0 : x, y: isNaN(y) ? 0 : y, label: label > 0.5 ? 1 : 0 };
                });

                // Automatic Min-Max Normalization to [-1, 1] range
                const xValues = rawPoints.map(p => p.x);
                const yValues = rawPoints.map(p => p.y);
                const minX = Math.min(...xValues);
                const maxX = Math.max(...xValues);
                const minY = Math.min(...yValues);
                const maxY = Math.max(...yValues);

                const denX = (maxX - minX) || 1;
                const denY = (maxY - minY) || 1;

                newPoints = rawPoints.map(p => ({
                    x: ((p.x - minX) / denX) * 2 - 1,
                    y: ((p.y - minY) / denY) * 2 - 1,
                    label: p.label
                }));
            } else {
                newPoints = JSON.parse(text);
            }

            setPoints(newPoints);
            setIsTraining(false);
            setCurrentPresetId(null);
        } catch (err) {
            console.error("Dataset import failed:", err);
            alert("Failed to import dataset.");
        }
    };

    const handleAddManualPoint = (x: number, y: number, label: number) => {
        setPoints(prev => [...prev, { x, y, label }]);
        setCurrentPresetId(null);
    };

    const handleLoadPreset = (id: string) => {
        const preset = PRESETS.find(p => p.id === id);
        if (preset) {
            setPoints(preset.points);
            setHiddenLayers(preset.recommendedArch);
            setCurrentPresetId(id);
            setIsTraining(false);
        }
    };

    const currentPreset = PRESETS.find(p => p.id === currentPresetId) || null;

    if (!isWasmReady) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6">
                <div className="w-16 h-16 border-4 border-cyan-500/20 border-t-cyan-500 rounded-full animate-spin shadow-[0_0_20px_rgba(6,182,212,0.2)]" />
                <div className="text-cyan-400 font-mono text-sm tracking-[0.3em] font-bold animate-pulse uppercase">Initializing Neural Core...</div>
            </div>
        );
    }

    return (
        <div className="w-full flex flex-col items-center gap-0">
            {/* Header section (Didactic title & desc) */}
            <div className="flex flex-col items-center mb-12">
                <div className="flex flex-col items-center gap-2">
                    <h1 className="text-3xl font-black bg-gradient-to-br from-cyan-400 to-blue-600 bg-clip-text text-transparent uppercase tracking-[0.3em] italic">
                        Neural <span className="">Playground</span>
                    </h1>
                    <div className="w-24 h-1 bg-gradient-to-r from-cyan-500/0 via-cyan-500 to-cyan-500/0 rounded-full mt-1" />
                </div>
                <p className="text-[9px] text-muted-foreground uppercase tracking-[0.3em] mt-4 font-bold text-center max-w-lg leading-relaxed">
                    Interactive Backpropagation Engine<br />
                    WASM-Core • Multi-Layer Perceptron Visualization
                </p>
            </div>

            {/* Main layout: left panel | canvas | right panel */}
            <div className="w-full max-w-7xl flex flex-col lg:flex-row items-center lg:items-start justify-center gap-8 px-4">

                {/* Left Column: Network Visualization */}
                <div className="flex flex-col gap-6 flex-shrink-0 w-full lg:w-80">
                    <WeightsViewer weights={weights} hiddenLayers={hiddenLayers} inputDim={activeFeatures.length} />
                </div>

                {/* Center Column: Interaction Canvas */}
                <div className="flex flex-col items-center flex-grow max-w-[600px] gap-6">
                    <PlaygroundCanvas
                        points={points}
                        onCanvasClick={handleCanvasClick}
                        decisionBoundary={decisionBoundary}
                        resolution={RESOLUTION}
                        width={600}
                        height={600}
                    />
                    <div className="flex gap-12 text-[10px] font-bold font-mono text-muted-foreground uppercase tracking-[0.3em]">
                        <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.3)]" />
                            <span>Class 0</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-orange-500 shadow-[0_0_8px_rgba(249,115,22,0.3)]" />
                            <span>Class 1</span>
                        </div>
                    </div>
                </div>

                {/* Right Column: Controls & Intelligence */}
                <div className="flex flex-col gap-6 flex-shrink-0 w-full lg:w-80">
                    <PlaygroundControls
                        isTraining={isTraining}
                        onToggleTraining={() => setIsTraining(!isTraining)}
                        onClearPoints={handleClear}
                        onExportWeights={handleExport}
                        onExportCCode={handleExportCCode}
                        onImportWeights={handleImport}
                        loss={loss}
                        learningRate={learningRate}
                        onLearningRateChange={setLearningRate}
                        currentLabel={currentLabel}
                        onLabelChange={setCurrentLabel}
                        hiddenLayers={hiddenLayers}
                        onAddLayer={handleAddLayer}
                        onRemoveLayer={handleRemoveLayer}
                        onUpdateNeurons={handleUpdateNeurons}
                        onExportDataset={handleExportDataset}
                        onImportDataset={handleImportDataset}
                        onAddManualPoint={handleAddManualPoint}
                        onLoadPreset={handleLoadPreset}
                        currentPresetId={currentPresetId}
                        activeFeatures={activeFeatures}
                        onToggleFeature={handleToggleFeature}
                    />
                    <PlaygroundExplanation preset={currentPreset} />
                </div>

            </div>
        </div>
    );
};
