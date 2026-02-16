import { useEffect, useRef, useState, useCallback } from 'react'
// This path assumes the user has built the pkg in the sibling directory
// In a real monorepo, you'd alias this in vite.config.ts or package.json
import * as wasm from './wasm/pkg/gran_prix_wasm'
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
  const [isRestarting, setIsRestarting] = useState(false);
  const gameState = useRef<GameState>({
    playerX: GAME_WIDTH / 2,
    obstacles: [],
    score: 0,
    generation: 1,
    speed: 5
  });
  const isComputing = useRef(false);
  const brainRef = useRef<wasm.NeuralBrain | null>(null);
  const rafId = useRef<number | null>(null);
  const isLoopActive = useRef(false);

  // Sync brain state to ref for loop access
  useEffect(() => {
    brainRef.current = brain;
    return () => { brainRef.current = null; };
  }, [brain]);

  // Initialize WASM
  const initWasm = useCallback(async () => {
    try {
      console.log("PRIX: Initializing WASM...");
      await wasm.default();
      wasm.init_panic_hook();
      
      const brainInstance = new wasm.NeuralBrain();
      setBrain(brainInstance);
      console.log("Gran-Prix Brain Online!");
    } catch (e) {
      console.error("Failed to load brain:", e);
    }
  }, []);

  useEffect(() => {
    if (!brain) initWasm();
  }, [initWasm, brain]);

  // Safe cleanup effect
  useEffect(() => {
    return () => {
      console.log("PRIX: Component unmounting...");
      if (rafId.current) cancelAnimationFrame(rafId.current);
      // We can't safely .free() if we aren't 100% sure the WASM stack is clear.
      const b = brain;
      if (b) setTimeout(() => { try { b.free(); } catch(e) {} }, 50);
    };
  }, [brain]);

  const resetGame = useCallback(() => {
     gameState.current.playerX = GAME_WIDTH / 2;
     gameState.current.obstacles = [];
     gameState.current.score = 0;
     gameState.current.speed = 5 + (gameState.current.generation * 0.5);
  }, []);

  const gameLoop = useCallback(() => {
    if (!isPlaying) {
      isLoopActive.current = false;
      return;
    }

    const currentBrain = brainRef.current;
    if (!currentBrain || !canvasRef.current) {
        rafId.current = requestAnimationFrame(gameLoop);
        return;
    }

    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    // 1. Update State
    const state = gameState.current;
    state.score++;
    if (state.score % 10 === 0) setStats(prev => ({ ...prev, score: state.score }));
    
    // Slowly increase speed over time
    if (state.score % 60 === 0) {
        state.speed += 0.25;
    }

    // Spawn Obstacles
    if (Math.random() < 0.02) {
       state.obstacles.push({
         x: Math.random() * (GAME_WIDTH - 100),
         y: -50,
         w: 50 + Math.random() * 50,
         h: 20
       });
    }

    // Move Obstacles
    state.obstacles.forEach(o => o.y += state.speed);
    state.obstacles = state.obstacles.filter(o => o.y < GAME_HEIGHT);

    // 2. AI Inference
    const sensors = [];
    const playerX = state.playerX;
    const playerY = GAME_HEIGHT - 50; 

    // Raycast logic - simplified for demo
    // 5 rays: -30, -15, 0, 15, 30 degrees
    const angles = [-0.5, -0.25, 0, 0.25, 0.5]; 
    
    for (let angle of angles) {
        let dist = 1.0; // Max normalized distance
        // Simple distinct check against obstacles
        // In a real game, this would be a proper raycast.
        // For now, let's just detect if an obstacle is "in the lane" of the ray.
        console.log("PRIX DEBUG: Ray angle", angle);
        
        // Find closest obstacle intersection
        for (let obs of state.obstacles) {
            // Very rough approx: check if obstacle is in front and close
            let dx = (obs.x + obs.w/2) - playerX;
            let dy = obs.y - playerY;
            let d = Math.sqrt(dx*dx + dy*dy);
            
            // Normalize to 0..1 (0 closest, 1 farthest/none)
            let normD = Math.max(0, Math.min(1, d / GAME_HEIGHT));
            
            // Angle check is tricky without real raycast, 
            // so we just use distance to nearest object generally for now to test stability
            if (normD < dist) {
                dist = normD;
            }
        }
        sensors.push(dist);
    }

    if (!isComputing.current && brainRef.current) {
        isComputing.current = true;
        try {
            // Paranoid check: ensure brain is still there
            if (!brainRef.current) throw new Error("Brain vanished");
            
            const steering = brainRef.current.compute(sensors[0], sensors[1], sensors[2], sensors[3], sensors[4]);
            
            // Map output 0..1 to -1..1 for steering
            // (0 = left, 0.5 = straight, 1 = right)
            // Reduced sensitivity from 10 to 4 to avoid "teleporting"
            const move = (steering - 0.5) * 2.0 * 4.0; 
            
            if (!isNaN(move)) {
                 state.playerX = Math.max(0, Math.min(GAME_WIDTH - PLAYER_SIZE, state.playerX + move));
            }
        } catch(e) {
            console.error("PRIX DEBUG: WASM ERROR", e);
            // CRITICAL: Stop loop immediately on ANY error
            isLoopActive.current = false;
            setIsPlaying(false);
            setBrain(null); 
            
            // Only restart if it's a known WASM trap
            if (e?.toString().includes("memory") || e?.toString().includes("unreachable") || e?.toString().includes("ptr")) {
                console.warn("PRIX: WASM Panic caught. Restarting...");
                setIsRestarting(true);
                setTimeout(() => setIsRestarting(false), 2000);
            }
            return;
        } finally {
            isComputing.current = false;
        }
    }

    // 3. Collision Detection
    const playerRect = { x: state.playerX, y: GAME_HEIGHT - 50, w: PLAYER_SIZE, h: PLAYER_SIZE };
    const hit = state.obstacles.some(o => 
        playerRect.x < o.x + o.w &&
        playerRect.x + playerRect.w > o.x &&
        playerRect.y < o.y + o.h &&
        playerRect.y + playerRect.h > o.y
    ) || state.playerX <= 0 || state.playerX >= GAME_WIDTH - PLAYER_SIZE;

    if (hit) {
       state.generation++;
       setStats(s => ({ ...s, generation: state.generation, best: Math.max(s.best, state.score) }));
       resetGame();
    }

    // 4. Render
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    // Player
    ctx.fillStyle = '#00ff41';
    ctx.fillRect(state.playerX, GAME_HEIGHT - 50, PLAYER_SIZE, PLAYER_SIZE);
    
    // Obstacles
    ctx.fillStyle = '#ff0055';
    state.obstacles.forEach(o => ctx.fillRect(o.x, o.y, o.w, o.h));

    rafId.current = requestAnimationFrame(gameLoop);
  }, [isPlaying, resetGame]);

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
        <Button onClick={() => setIsPlaying(!isPlaying)} disabled={isRestarting}>
           {isRestarting ? 'RESTARTING ENGINE...' : (isPlaying ? 'PAUSE SIMULATION' : 'START ENGINE')}
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
