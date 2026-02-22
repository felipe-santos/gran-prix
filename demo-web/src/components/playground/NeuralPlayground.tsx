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
    const [hiddenLayers, setHiddenLayers] = useState<number[]>([8, 8]);
    const [currentPresetId, setCurrentPresetId] = useState<string | null>(null);

    // Config
    const RESOLUTION = 40;
    const rafId = useRef<number | null>(null);

    // 1. Initialize WASM
    useEffect(() => {
        let mounted = true;
        const init = async () => {
            try {
                await wasm.default();
                if (mounted) {
                    const t = new wasm.Trainer(new Uint32Array(hiddenLayers));
                    setTrainer(t);
                    setIsWasmReady(true);

                    const initWeights = t.get_weights();
                    setWeights(initWeights);
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
    }, [hiddenLayers]);

    // 2. Training Loop
    const trainLoop = useCallback(() => {
        if (!trainer || points.length === 0 || !isTraining) {
            if (isTraining && points.length === 0) setIsTraining(false);
            return;
        }

        const xs = new Float32Array(points.length);
        const ys = new Float32Array(points.length);
        const ts = new Float32Array(points.length);

        points.forEach((p, i) => {
            xs[i] = p.x;
            ys[i] = p.y;
            ts[i] = p.label;
        });

        const currentLoss = trainer.train_batch(xs, ys, ts, learningRate);
        setLoss(currentLoss);

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
        setCurrentPresetId(null);
    };

    const handleClear = () => {
        setPoints([]);
        setIsTraining(false);
        setLoss(0);
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
                    <WeightsViewer weights={weights} hiddenLayers={hiddenLayers} />
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
                    <PlaygroundExplanation preset={currentPreset} />
                </div>

            </div>
        </div>
    );
};
