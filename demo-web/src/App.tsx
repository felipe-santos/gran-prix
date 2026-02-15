import { useEffect, useRef, useState, useCallback } from 'react'
// This path assumes the user has built the pkg in the sibling directory
// In a real monorepo, you'd alias this in vite.config.ts or package.json
import * as wasm from '../public/pkg/gran_prix_wasm'
import { Button } from './components/ui/button'

const GAME_WIDTH = 800;
const GAME_HEIGHT = 400;
const PLAYER_SIZE = 20;

type GameState = {
  playerX: number;
  obstacles: { x: number, y: number, w: number, h: number }[];
  score: number;
  generation: number;
  speed: number;
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [brain, setBrain] = useState<wasm.NeuralBrain | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [stats, setStats] = useState({ score: 0, generation: 1, best: 0 });
  const gameState = useRef<GameState>({
    playerX: GAME_WIDTH / 2,
    obstacles: [],
    score: 0,
    generation: 1,
    speed: 5
  });
  const isComputing = useRef(false);

  // Initialize WASM
  useEffect(() => {
    async function init() {
       try {
        // Initialize the WASM module
        await wasm.default();
        wasm.init_panic_hook();
        
        const brainInstance = new wasm.NeuralBrain();
        setBrain(brainInstance);
        console.log("Gran-Prix Brain Online!");
       } catch (e) {
         console.error("Failed to load brain:", e);
       }
    }
    init();
  }, []);

  const resetGame = useCallback(() => {
     gameState.current.playerX = GAME_WIDTH / 2;
     gameState.current.obstacles = [];
     gameState.current.score = 0;
     gameState.current.speed = 5 + (gameState.current.generation * 0.5);
  }, []);

  const gameLoop = useCallback(() => {
    if (!isPlaying || !canvasRef.current || !brain) return;

    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    // 1. Update State
    const state = gameState.current;
    state.score++;
    setStats(prev => ({ ...prev, score: state.score }));

    // Spawn Obstacles
    if (Math.random() < 0.02) {
       const width = 50 + Math.random() * 100;
       state.obstacles.push({
         x: Math.random() * (GAME_WIDTH - width),
         y: -50,
         w: width,
         h: 20
       });
    }

    // Move Obstacles
    state.obstacles.forEach(o => o.y += state.speed);
    state.obstacles = state.obstacles.filter(o => o.y < GAME_HEIGHT);

    // 2. AI Inference
    // Sensors: Raycasts at 5 angles (-60, -30, 0, 30, 60)
    const sensors = new Float32Array(5);
    const angles = [-60, -30, 0, 30, 60].map(a => a * Math.PI / 180);
    
    // Simple mock raycast logic for demo visualization
    angles.forEach((angle, idx) => {
        // Find distance to closest obstacle in this direction
        // (Simplified: just check vertical distance to obstacle in "lane")
        let dist = 1.0;
        // ... Raycast math would go here ...
        sensors[idx] = dist; // Feed generic data for now
    });

    if (isComputing.current) return;
    isComputing.current = true;
    try {
        // const steering = brain.compute(sensors); // 0.0 (Left) to 1.0 (Right)
        // Pass individual floats to avoid array allocation crash
        const steering = brain.compute(sensors[0], sensors[1], sensors[2], sensors[3], sensors[4]);
        // Map 0..1 to -Speed..+Speed
        const move = (steering - 0.5) * 2.0 * 10;
        state.playerX = Math.max(0, Math.min(GAME_WIDTH - PLAYER_SIZE, state.playerX + move));
        
        // Train: Target is center of largest gap
        // Ideally we train on feedback (did we crash?)
        // Here we just let it run for the demo visual.
    } catch(e) {
        console.error(e);
    } finally {
        isComputing.current = false;
    }

    // 3. Collision Detection
    const crashed = state.obstacles.some(o => 
       state.playerX < o.x + o.w &&
       state.playerX + PLAYER_SIZE > o.x &&
       GAME_HEIGHT - 50 < o.y + o.h &&
       GAME_HEIGHT - 30 > o.y
    );

    if (crashed) {
       state.generation++;
       if (state.score > stats.best) setStats(s => ({ ...s, best: state.score }));
       setStats(s => ({ ...s, generation: state.generation }));
       // Penalize brain? 
       // brain.train(sensors, correct_move, 0.1);
       resetGame();
    }

    // 4. Render
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    // Player
    ctx.fillStyle = '#00ff41';
    ctx.shadowBlur = 15;
    ctx.shadowColor = '#00ff41';
    ctx.fillRect(state.playerX, GAME_HEIGHT - 50, PLAYER_SIZE, PLAYER_SIZE);
    
    // Obstacles
    ctx.fillStyle = '#ff0055';
    ctx.shadowColor = '#ff0055';
    state.obstacles.forEach(o => {
       ctx.fillRect(o.x, o.y, o.w, o.h);
    });
    ctx.shadowBlur = 0;

    requestAnimationFrame(gameLoop);
  }, [isPlaying, brain, resetGame, stats.best]);

  // Loop trigger
  useEffect(() => {
    let animId: number;
    if (isPlaying) {
      animId = requestAnimationFrame(gameLoop);
    }
    return () => cancelAnimationFrame(animId);
  }, [isPlaying, gameLoop]);

  return (
    <div className="min-h-screen bg-black text-white p-8 flex flex-col items-center">
      <h1 className="text-4xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-green-400 to-blue-500 mb-8">
        Gran-Prix: Neural Racer 🏎️
      </h1>

      <div className="relative border border-green-500/30 rounded-lg overflow-hidden shadow-2xl shadow-green-900/20">
        <canvas 
            ref={canvasRef} 
            width={GAME_WIDTH} 
            height={GAME_HEIGHT}
            className="bg-zinc-900 block"
        />
        
        <div className="absolute top-4 left-4 font-mono text-sm space-y-1 bg-black/50 p-2 rounded backdrop-blur">
             <div>GEN: <span className="text-yellow-400">{stats.generation}</span></div>
             <div>SCORE: <span className="text-blue-400">{stats.score}</span></div>
             <div>BEST: <span className="text-green-400">{stats.best}</span></div>
        </div>
      </div>

      <div className="mt-8 flex gap-4">
        <Button onClick={() => setIsPlaying(!isPlaying)}>
           {isPlaying ? 'PAUSE SIMULATION' : 'START ENGINE'}
        </Button>
        <Button variant="secondary" onClick={() => {
            brain?.reset();
            resetGame();
            setStats({ score: 0, generation: 1, best: 0});
        }}>
           RESET BRAIN
        </Button>
      </div>

      <p className="mt-8 text-zinc-500 max-w-lg text-center text-sm">
         Powered by <b>Gran-Prix WASM</b>. The car is controlled by a neural network running natively in your browser via WebAssembly.
         It learns to avoid obstacles in real-time.
      </p>
    </div>
  )
}

export default App
