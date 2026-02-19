import * as wasm from './wasm/pkg/gran_prix_wasm';
import { useEffect, useRef, useState, useCallback } from 'react'

// Types & Hooks
import { 
    GAME_WIDTH, 
    GAME_HEIGHT, 
    PLAYER_SIZE, 
    POPULATION_SIZE, 
    GameStats,
    Car
} from './types'
import { useWasmPopulation } from './hooks/useWasmPopulation'
import { useGameLoop } from './hooks/useGameLoop'

// Components
import { Header } from './components/Header'
import { GameCanvas } from './components/GameCanvas'
import { StatsBar } from './components/StatsBar'
import { GameControls } from './components/GameControls'
import { ThemeToggle } from './components/ThemeToggle'
import { BrainInspector } from './components/BrainInspector'
import { LearningLab } from './components/LearningLab'
import { PerformanceCharts, PerformanceData } from './components/PerformanceCharts'
import { ClassifierDemo } from './components/ClassifierDemo'
import GoogleTagManager from './components/GoogleTagManager';

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [stats, setStats] = useState<GameStats>({ score: 0, generation: 1, best: 0, alive: 0 });
  const [isRestarting] = useState(false);
  const [showInspector, setShowInspector] = useState(false);
  const [activeTab, setActiveTab] = useState<'evolution' | 'training'>('evolution');
  
  // Learning Lab State
  const [mutationRate, setMutationRate] = useState(0.2);
  const [mutationScale, setMutationScale] = useState(0.5);
  const [mutationStrategy, setMutationStrategy] = useState<wasm.MutationStrategy>(wasm.MutationStrategy.Additive);
  const [customKernel, setCustomKernelState] = useState<[number, number, number]>([0, 1, 0]);
  const [performanceHistory, setPerformanceHistory] = useState<PerformanceData[]>([]);
  
  const { population, initWasm, evolve: wasmEvolve, computeAll, getBestBrainSnapshot, setGlobalKernel } = useWasmPopulation();

  const evolve = useCallback((fitnessScores: number[], rate: number, scale: number, strategy: wasm.MutationStrategy) => {
    // Collect Metrics
    const max = Math.max(...fitnessScores);
    const avg = fitnessScores.reduce((a, b) => a + b, 0) / fitnessScores.length;
    
    setPerformanceHistory(prev => {
      const nextGen = prev.length > 0 ? prev[prev.length - 1].generation + 1 : 1;
      const newHistory = [...prev, { generation: nextGen, avg, max }];
      return newHistory.slice(-50); // Keep last 50 generations
    });

    // Original Evolve
    wasmEvolve(fitnessScores, rate, scale, strategy);
  }, [wasmEvolve]);

  const { gameState, resetGame, updatePhysics } = useGameLoop({
    computeAll,
    evolve,
    setStats,
    mutationRate,
    mutationScale,
    mutationStrategy
  });

  const rafId = useRef<number | null>(null);
  const isLoopActive = useRef(false);

  // Initialize WASM
  useEffect(() => {
    if (!population) {
        initWasm().then(() => {
            // Init cars in gameState
            const cars: Car[] = [];
            for(let i=0; i<POPULATION_SIZE; i++) {
                cars.push({
                    id: i,
                    x: GAME_WIDTH / 2,
                    y: GAME_HEIGHT - 50,
                    dead: false,
                    fitness: 0,
                    color: `hsl(${Math.random() * 360}, 80%, 60%)`
                });
            }
            gameState.current.cars = cars;
            setStats(s => ({ ...s, alive: POPULATION_SIZE }));
        });
    }
  }, [initWasm, population, gameState]);

  const render = useCallback((ctx: CanvasRenderingContext2D) => {
    const state = gameState.current;

    // Clear with slight trail effect
    const trailColor = getComputedStyle(document.documentElement).getPropertyValue('--canvas-trail').trim() || 'rgba(10, 10, 11, 0.4)';
    ctx.fillStyle = trailColor;
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    // Draw Grid (Feng Shui detail)
    const gridStyle = getComputedStyle(document.documentElement).getPropertyValue('--canvas-grid').trim() || 'rgba(255, 255, 255, 0.03)';
    ctx.strokeStyle = gridStyle;
    ctx.lineWidth = 1;
    for(let x=0; x<GAME_WIDTH; x+=40) {
        ctx.beginPath();
        ctx.moveTo(x, 0); ctx.lineTo(x, GAME_HEIGHT);
        ctx.stroke();
    }
    for(let y=0; y<GAME_HEIGHT; y+=40) {
        ctx.beginPath();
        ctx.moveTo(0, y); ctx.lineTo(GAME_WIDTH, y);
        ctx.stroke();
    }

    // Obstacles
    state.obstacles.forEach(o => {
        ctx.fillStyle = '#ff0055';
        ctx.fillRect(o.x, o.y, o.w, o.h);
    });
    
    // Cars
    state.cars.forEach(car => {
        if (car.dead) {
          if (document.documentElement.getAttribute('data-theme') === 'dark') {
            ctx.fillStyle = '#1a1a1c';
          } else {
            ctx.fillStyle = '#ece4e7ff';
          }
          ctx.globalAlpha = 0.2;
        } else {
          ctx.fillStyle = car.color;
          ctx.globalAlpha = 1.0;
        }
        
        ctx.beginPath();
        ctx.roundRect(car.x, car.y, PLAYER_SIZE, PLAYER_SIZE, 2);
        ctx.fill();
    });
    ctx.globalAlpha = 1.0;
  }, [gameState]);

  const gameLoop = useCallback(() => {
    if (!isPlaying) {
      isLoopActive.current = false;
      return;
    }

    if (!canvasRef.current) {
        rafId.current = requestAnimationFrame(gameLoop);
        return;
    }

    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    // 1. Update Physics
    updatePhysics();

    // 2. Render
    render(ctx);

    rafId.current = requestAnimationFrame(gameLoop);
  }, [isPlaying, updatePhysics, render]);

  useEffect(() => {
    if (isPlaying && !isLoopActive.current) {
        isLoopActive.current = true;
        rafId.current = requestAnimationFrame(gameLoop);
    }
    return () => {
        if (rafId.current) cancelAnimationFrame(rafId.current);
        isLoopActive.current = false;
    };
  }, [isPlaying, gameLoop]);

  return (
    <div className="min-h-screen bg-background text-foreground p-4 md:p-12 flex flex-col items-center selection:bg-emerald-500/30">
      <GoogleTagManager />
      <ThemeToggle />
      <Header />

      <div className="flex gap-4 mb-8 p-1 bg-white/5 border border-white/10 rounded-xl">
        {(['evolution', 'training'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-6 py-2 rounded-lg text-[10px] font-bold uppercase tracking-[0.2em] transition-all ${
              activeTab === tab 
              ? 'bg-emerald-500 text-black shadow-lg shadow-emerald-500/20' 
              : 'text-muted-foreground hover:text-foreground hover:bg-white/5'
            }`}
          >
            {tab === 'evolution' ? 'Genetic Evolution' : 'Backprop Training'}
          </button>
        ))}
      </div>

      <main className="w-full max-w-7xl flex flex-col lg:flex-row items-center lg:items-start justify-center gap-8 transition-all duration-500">
        {activeTab === 'training' ? (
          <div className="w-full flex justify-center py-12">
            <ClassifierDemo isWasmReady={!!population} />
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-6 flex-shrink-0">
          <div className="pt-0">
            <LearningLab 
              mutationRate={mutationRate}
              setMutationRate={setMutationRate}
              mutationScale={mutationScale}
              setMutationScale={setMutationScale}
              mutationStrategy={mutationStrategy}
              setMutationStrategy={setMutationStrategy}
              customKernel={customKernel}
              setCustomKernel={(k: [number, number, number]) => {
                setCustomKernelState(k);
                setGlobalKernel(k[0], k[1], k[2]);
              }}
            />
          </div>
        </div>
        
        <div className="flex flex-col items-center flex-shrink-0">
          <StatsBar stats={stats} />
          <GameCanvas 
              ref={canvasRef} 
              width={GAME_WIDTH} 
              height={GAME_HEIGHT}
          />

          <GameControls 
              isPlaying={isPlaying}
              onTogglePlay={() => setIsPlaying(!isPlaying)}
              onReset={() => {
                  resetGame();
                  setStats({ score: 0, generation: 1, best: 0, alive: POPULATION_SIZE});
              }}
              isRestarting={isRestarting}
          />
          
          <div className="w-full mt-8">
            <PerformanceCharts data={performanceHistory} />
          </div>
          
          {!showInspector && (
            <button 
              onClick={() => setShowInspector(true)}
              className="mt-6 px-4 py-2 bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 rounded-lg border border-emerald-500/20 text-[10px] uppercase tracking-widest font-bold transition-all"
            >
              Inspect Specialist Agent Brain
            </button>
          )}
        </div>

        {showInspector && (
          <div className="flex flex-col gap-6 flex-shrink-0">
            <div className="pt-0">
              <BrainInspector 
                nodes={getBestBrainSnapshot(Float32Array.from(gameState.current.cars.map(c => c.fitness))) || []} 
                onClose={() => setShowInspector(false)} 
              />
            </div>
            
          </div>
        )}
          </>
        )}
      </main>

      <footer className="pt-12 text-muted-foreground text-[8px] uppercase tracking-[0.4em] font-medium pb-12 w-full text-center">
        Gran-Prix Simulation Protocol • 2026
      </footer>
    </div>
  )
}

export default App
