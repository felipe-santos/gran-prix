import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as wasm from '../../wasm/pkg/gran_prix_wasm';

// Components
import { PlaygroundCanvas, DataPoint } from './PlaygroundCanvas';
import { PlaygroundControls } from './PlaygroundControls';
import { WeightsViewer } from './WeightsViewer';
import { PlaygroundExplanation } from './PlaygroundExplanation';
import { PRESETS } from './PlaygroundPresets';

export const NeuralPlayground: React.FC = () => {
    // WASM Init State
    const [trainer, setTrainer] = useState<wasm.Trainer | null>(null);
    const [isWasmReady, setIsWasmReady] = useState(false);

    // Application State
    const [points, setPoints] = useState<DataPoint[]>([]);
    const [currentLabel, setCurrentLabel] = useState<number>(0);
    const [isTraining, setIsTraining] = useState(false);
    const [learningRate, setLearningRate] = useState(0.05);
    const [loss, setLoss] = useState(0.0);
    const [weights, setWeights] = useState<Float32Array | null>(null);
    const [decisionBoundary, setDecisionBoundary] = useState<number[]>([]);
    const [hiddenLayers, setHiddenLayers] = useState<number[]>([8, 8]); // Default to 2 layers of 8 neurons
    const [currentPresetId, setCurrentPresetId] = useState<string | null>(null);

    // Config
    const RESOLUTION = 40; // Generate a 40x40 grid for decision boundary heatmap

    const rafId = useRef<number | null>(null);

    // 1. Initialize WASM inside useEffect
    useEffect(() => {
        let mounted = true;
        const init = async () => {
            try {
                await wasm.default();
                if (mounted) {
                    const t = new wasm.Trainer(new Uint32Array(hiddenLayers));
                    setTrainer(t);
                    setIsWasmReady(true);

                    // Initial fetch
                    const initWeights = t.get_weights();
                    setWeights(initWeights);
                    // Generate initial blind boundary
                    setDecisionBoundary(Array.from(t.get_decision_boundary(RESOLUTION)));
                }
            } catch (err) {
                console.error("Failed to initialize WASM Trainer", err);
            }
        };
        init();
        return () => {
            mounted = false;
            if (trainer) trainer.free();
        };
    }, [hiddenLayers]); // Re-initialize if layers change

    // 2. Training Loop
    const trainLoop = useCallback(() => {
        if (!trainer || points.length === 0 || !isTraining) {
            if (isTraining && points.length === 0) setIsTraining(false); // Auto-stop if no points
            return;
        }

        // Prepare batch arrays
        const xs = new Float32Array(points.length);
        const ys = new Float32Array(points.length);
        const ts = new Float32Array(points.length);

        points.forEach((p, i) => {
            xs[i] = p.x;
            ys[i] = p.y;
            ts[i] = p.label;
        });

        // Run batch training
        const currentLoss = trainer.train_batch(xs, ys, ts, learningRate);
        setLoss(currentLoss);

        // Update visuals periodically to avoid stuttering
        // We update weights and boundary every frame here because it's a small network, but we could throttle if needed.
        setWeights(trainer.get_weights());
        setDecisionBoundary(Array.from(trainer.get_decision_boundary(RESOLUTION)));

        rafId.current = requestAnimationFrame(trainLoop);
    }, [trainer, points, isTraining, learningRate]);

    useEffect(() => {
        if (isTraining) {
            rafId.current = requestAnimationFrame(trainLoop);
        }
        return () => {
            if (rafId.current) cancelAnimationFrame(rafId.current);
        };
    }, [isTraining, trainLoop]);

    // 3. Handlers
    const handleCanvasClick = (x: number, y: number) => {
        setPoints(prev => [...prev, { x, y, label: currentLabel }]);
        setCurrentPresetId(null); // User modified data, clear preset highlight
    };

    const handleClear = () => {
        setPoints([]);
        setIsTraining(false);
        setLoss(0);
        if (trainer) {
            // Re-instantiate to truly clear weights? Or just clear points?
            // Actually, "Clear Canvas" usually just clears points. We can let the user decide.
            // But let's keep the model as is.
        }
    };

    const handleExport = () => {
        if (!weights) return;
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(Array.from(weights)));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", "gran_prix_weights.json");
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
    };

    const handleImport = async (file: File) => {
        if (!trainer) return;
        try {
            const text = await file.text();
            const arr = JSON.parse(text);
            if (!Array.isArray(arr)) throw new Error("Invalid format");
            const floatArr = new Float32Array(arr);

            trainer.import_weights(floatArr);

            // Update UI
            setWeights(trainer.get_weights());
            setDecisionBoundary(Array.from(trainer.get_decision_boundary(RESOLUTION)));
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
        setHiddenLayers(prev => prev.map((n, i) => i === index ? Math.max(1, Math.min(64, n + delta)) : n));
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
            const data = JSON.parse(text);
            if (Array.isArray(data)) {
                setPoints(data);
            }
        } catch (err) {
            console.error("Dataset import failed:", err);
            alert("Failed to import dataset JSON.");
        }
    };

    const handleAddManualPoint = (x: number, y: number, label: number) => {
        setPoints(prev => [...prev, { x, y, label }]);
        setCurrentPresetId(null); // User modified data, clear preset highlight
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
        return <div className="p-24 text-center text-cyan-400 font-mono animate-pulse">Initializing WASM Backend...</div>;
    }

    return (
        <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 flex flex-col gap-8">
            <div className="text-center space-y-4 max-w-3xl mx-auto mb-8">
                <h1 className="text-3xl md:text-5xl font-light tracking-tight text-white">Neural <span className="font-semibold bg-gradient-to-r from-cyan-400 to-blue-500 bg-clip-text text-transparent">Playground</span></h1>
                <p className="text-muted-foreground">
                    Click the canvas to add training data. The WASM neural network updates live using Backpropagation. Export your trained weights when completely separated!
                </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">

                {/* Left Column: Canvas (Col Span 5) */}
                <div className="lg:col-span-5 flex flex-col">
                    <PlaygroundCanvas
                        points={points}
                        onCanvasClick={handleCanvasClick}
                        decisionBoundary={decisionBoundary}
                        resolution={RESOLUTION}
                        width={600}
                        height={600}
                    />
                </div>

                {/* Middle Column: Controls (Col Span 3) */}
                <div className="lg:col-span-3">
                    <PlaygroundControls
                        isTraining={isTraining}
                        onToggleTraining={() => setIsTraining(!isTraining)}
                        onClearPoints={handleClear}
                        onExportWeights={handleExport}
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
                    />
                    <div className="mt-6">
                        <PlaygroundExplanation preset={currentPreset} />
                    </div>
                </div>

                {/* Right Column: Weight Viewer (Col Span 4) */}
                <div className="lg:col-span-4 h-full">
                    <WeightsViewer weights={weights} hiddenLayers={hiddenLayers} />
                </div>

            </div>
        </div>
    );
};
