import { useEffect, useRef, useState, useCallback } from 'react'
import * as wasm from './wasm/pkg/gran_prix_wasm'
import { Button } from './components/ui/button'

const GAME_WIDTH = 800;
const GAME_HEIGHT = 400;
const PLAYER_SIZE = 20;
const POPULATION_SIZE = 10;

type Car = {
    id: number;
    x: number;
    y: number;
    dead: boolean;
    fitness: number;
    color: string;
}

type GameState = {
  cars: Car[];
  obstacles: { x: number, y: number, w: number, h: number }[];
  score: number;
  generation: number;
  speed: number;
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [population, setPopulation] = useState<wasm.Population | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [stats, setStats] = useState({ score: 0, generation: 1, best: 0, alive: 0 });
  const [isRestarting, setIsRestarting] = useState(false);
  
  const gameState = useRef<GameState>({
    cars: [],
    obstacles: [],
    score: 0,
    generation: 1,
    speed: 5
  });
  
  const isComputing = useRef(false);
  const popRef = useRef<wasm.Population | null>(null);
  const rafId = useRef<number | null>(null);
  const isLoopActive = useRef(false);

  // Sync population to ref
  useEffect(() => {
    popRef.current = population;
    return () => { popRef.current = null; };
  }, [population]);

  // Initialize WASM and Population
  const initialized = useRef(false);

  const initWasm = useCallback(async () => {
    if (initialized.current) return; // Prevent double-init
    initialized.current = true;

    try {
      console.log("PRIX: Initializing WASM...");
      await wasm.default();
      wasm.init_panic_hook();
      
      const pop = new wasm.Population(POPULATION_SIZE);
      setPopulation(pop);
      console.log(`Gran-Prix Population Online! Size: ${pop.count()}`);
      
      // Init cars
      const cars = [];
      for(let i=0; i<POPULATION_SIZE; i++) {
          cars.push({
              id: i,
              x: GAME_WIDTH / 2,
              y: GAME_HEIGHT - 50,
              dead: false,
              fitness: 0,
              color: `hsl(${Math.random() * 360}, 100%, 50%)`
          });
      }
      gameState.current.cars = cars;
      setStats(s => ({ ...s, alive: POPULATION_SIZE }));

    } catch (e) {
      console.error("Failed to load WASM:", e);
    }
  }, []);

  useEffect(() => {
    if (!population) initWasm();
  }, [initWasm, population]);

  const resetGame = useCallback(() => {
     gameState.current.cars.forEach(c => {
         c.x = GAME_WIDTH / 2;
         c.dead = false;
         c.fitness = 0;
     });
     gameState.current.obstacles = [];
     gameState.current.score = 0;
     gameState.current.speed = 5 + (gameState.current.generation * 0.2); // Ramp up speed
     setStats(s => ({ ...s, alive: POPULATION_SIZE }));
  }, []);

  const evolveParams = useCallback(() => {
      if (!popRef.current) return;
      
      // Collect fitness scores
      const validScores = gameState.current.cars.map(c => c.fitness);
      
      try {
          popRef.current.evolve(Float32Array.from(validScores));
          
          gameState.current.generation++;
          setStats(s => ({ 
              ...s, 
              generation: gameState.current.generation,
              best: Math.max(s.best, Math.max(...validScores))
          }));
          
          resetGame();
      } catch(e) {
          console.error("Evolution failed:", e);
          setIsPlaying(false);
      }
  }, [resetGame]);

  const gameLoop = useCallback(() => {
    if (!isPlaying) {
      isLoopActive.current = false;
      return;
    }

    if (!popRef.current || !canvasRef.current) {
        rafId.current = requestAnimationFrame(gameLoop);
        return;
    }

    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    const state = gameState.current;

    // 1. Check End of Generation
    const aliveCars = state.cars.filter(c => !c.dead);
    if (aliveCars.length === 0) {
        evolveParams();
        rafId.current = requestAnimationFrame(gameLoop);
        return;
    }
    
    // Update Score
    state.score++;
    if (state.score % 10 === 0) {
        setStats(prev => ({ ...prev, score: state.score, alive: aliveCars.length }));
    }
    
    // Increase speed / difficulty
    if (state.score % 60 === 0) {
        state.speed += 0.1;
    }

    // Spawn Obstacles
    if (Math.random() < 0.03) {
       state.obstacles.push({
         x: Math.random() * (GAME_WIDTH - 100),
         y: -50,
         w: 40 + Math.random() * 60,
         h: 20
       });
    }

    // Move Obstacles
    state.obstacles.forEach(o => o.y += state.speed);
    state.obstacles = state.obstacles.filter(o => o.y < GAME_HEIGHT);

    // 2. Prepare Inputs for Population
    // We need 5 sensors per car. Flat array.
    const inputs = new Float32Array(state.cars.length * 5);
    
    const angles = [-0.5, -0.25, 0, 0.25, 0.5]; 
    
    state.cars.forEach((car, idx) => {
        if (car.dead) {
            // Dead cars get zero input (doesn't matter)
            return; 
        }

        // Calculate sensors
        for (let i = 0; i < 5; i++) {
            let dist = 1.0; 
            const angle = angles[i]; // Not used for real raycast yet, simplified check
            
            for (let obs of state.obstacles) {
                // Simplified distance check relative to "lane"
                // A real raycast would calculate itersection with line segment
                // Here we approximate:
                // Check if obstacle is roughly in direction of sensor
                
                let dx = (obs.x + obs.w/2) - car.x;
                let dy = obs.y - car.y;
                
                // Simple logical cone?
                // Let's use distance to closest object in front
                if (dy < 0) { // Object is behind us (y increases downwards?) 
                   // WAIT: y=0 is top. Car is at bottom (GAME_HEIGHT - 50).
                   // Obstacles move DOWN (y increases).
                   // So `obs.y` < `car.y` usually.
                   // Distance is positive.
                }
                
                let d = Math.sqrt(dx*dx + dy*dy);
                let normD = Math.max(0, Math.min(1, d / GAME_HEIGHT));
                
                // Directional filtering
                // Left sensors care about objects to the left, etc.
                // dx < 0 is left. 
                if (angle < 0 && dx > 20) continue;
                if (angle > 0 && dx < -20) continue;
                if (angle === 0 && Math.abs(dx) > 40) continue;

                if (normD < dist) dist = normD;
            }
            inputs[idx * 5 + i] = dist;
        }
        
        // Bonus for speed/staying alive
        car.fitness += 1; 
    });

    // 3. Compute Population
    if (!isComputing.current) {
        isComputing.current = true;
        try {
            const outputs = popRef.current.compute_all(inputs);
            
            // Apply outputs
            state.cars.forEach((car, idx) => {
                if (car.dead) return;
                
                const steering = outputs[idx]; // 0..1
                const move = (steering - 0.5) * 2.0 * 5.0; // -1..1 * speed
                
                car.x += move;
                car.x = Math.max(0, Math.min(GAME_WIDTH - PLAYER_SIZE, car.x));
            });

        } catch(e) {
            console.error("WASM Compute Error:", e);
            setIsPlaying(false);
        } finally {
            isComputing.current = false;
        }
    }

    // 4. Collision Detection
    state.cars.forEach(car => {
        if (car.dead) return;
        
        const playerRect = { x: car.x, y: car.y, w: PLAYER_SIZE, h: PLAYER_SIZE };
        const hit = state.obstacles.some(o => 
            playerRect.x < o.x + o.w &&
            playerRect.x + playerRect.w > o.x &&
            playerRect.y < o.y + o.h &&
            playerRect.y + playerRect.h > o.y
        ) || car.x <= 0 || car.x >= GAME_WIDTH - PLAYER_SIZE;

        if (hit) {
            car.dead = true;
            // Penalize slightly for crashing? Or just stop accumulating fitness.
        }
    });


    // 5. Render
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    // Obstacles
    ctx.fillStyle = '#ff0055';
    state.obstacles.forEach(o => ctx.fillRect(o.x, o.y, o.w, o.h));
    
    // Cars
    state.cars.forEach(car => {
        if (car.dead) {
            ctx.fillStyle = '#333'; // Dead color
            ctx.globalAlpha = 0.3;
        } else {
            ctx.fillStyle = car.color;
            ctx.globalAlpha = 1.0;
        }
        ctx.fillRect(car.x, car.y, PLAYER_SIZE, PLAYER_SIZE);
    });
    ctx.globalAlpha = 1.0;

    rafId.current = requestAnimationFrame(gameLoop);
  }, [isPlaying, evolveParams]);

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
        Gran-Prix: Evolutionary Racer 🧬
      </h1>

      <div className="relative border border-green-500/30 rounded-lg overflow-hidden shadow-2xl shadow-green-900/20">
        <canvas 
            ref={canvasRef} 
            width={GAME_WIDTH} 
            height={GAME_HEIGHT}
            className="bg-zinc-900 block"
        />
        
        <div className="absolute top-4 left-4 font-mono text-sm space-y-1 bg-black/50 p-2 rounded backdrop-blur border border-white/10">
             <div>GEN: <span className="text-yellow-400">{stats.generation}</span></div>
             <div>ALIVE: <span className="text-green-400">{stats.alive}</span> / {POPULATION_SIZE}</div>
             <div>BEST: <span className="text-blue-400">{Math.floor(stats.best)}</span></div>
             <div>SCORE: <span className="text-white">{stats.score}</span></div>
        </div>
      </div>

      <div className="mt-8 flex gap-4">
        <Button onClick={() => setIsPlaying(!isPlaying)} disabled={isRestarting}>
           {isRestarting ? 'RESTARTING...' : (isPlaying ? 'PAUSE EVOLUTION' : 'START EVOLUTION')}
        </Button>
        <Button variant="secondary" onClick={() => {
            resetGame();
            setStats({ score: 0, generation: 1, best: 0, alive: POPULATION_SIZE});
        }}>
           RESET SIMULATION
        </Button>
      </div>

      <p className="mt-8 text-zinc-500 max-w-lg text-center text-sm">
         Population of <b>{POPULATION_SIZE} neural networks</b> evolving in real-time.
         Survivors are selected for the next generation.
      </p>
    </div>
  )
}

export default App
