import { useCallback, useRef } from 'react';
import { 
    GAME_WIDTH, 
    GAME_HEIGHT, 
    PLAYER_SIZE, 
    POPULATION_SIZE, 
    GameState, 
    GameStats
} from '../types';

interface UseGameLoopProps {
    computeAll: (inputs: Float32Array) => any;
    evolve: (fitnessScores: number[]) => void;
    setStats: React.Dispatch<React.SetStateAction<GameStats>>;
}

export function useGameLoop({ computeAll, evolve, setStats }: UseGameLoopProps) {
    const gameState = useRef<GameState>({
        cars: [],
        obstacles: [],
        score: 0,
        generation: 1,
        speed: 5
    });
    const isComputing = useRef(false);

    const resetGame = useCallback(() => {
        gameState.current.cars.forEach(c => {
            c.x = GAME_WIDTH / 2;
            c.dead = false;
            c.fitness = 0;
        });
        gameState.current.obstacles = [];
        gameState.current.score = 0;
        gameState.current.speed = 5 + (gameState.current.generation * 0.2);
        setStats(s => ({ ...s, alive: POPULATION_SIZE, score: 0 }));
    }, [setStats]);

    const evolveParams = useCallback(() => {
        const validScores = gameState.current.cars.map(c => c.fitness);
        try {
            evolve(validScores);
            gameState.current.generation++;
            setStats(s => ({ 
                ...s, 
                generation: gameState.current.generation,
                best: Math.max(s.best, Math.max(...validScores))
            }));
            resetGame();
        } catch(e) {
            console.error("Evolution failed:", e);
        }
    }, [evolve, resetGame, setStats]);

    const updatePhysics = useCallback(() => {
        const state = gameState.current;
        const aliveCars = state.cars.filter(c => !c.dead);

        if (aliveCars.length === 0) {
            evolveParams();
            return;
        }

        state.score++;
        if (state.score % 10 === 0) {
            setStats(prev => ({ ...prev, score: state.score, alive: aliveCars.length }));
        }
        
        if (state.score % 60 === 0) {
            state.speed += 0.1;
        }

        if (Math.random() < 0.03) {
            state.obstacles.push({
                x: Math.random() * (GAME_WIDTH - 100),
                y: -50,
                w: 40 + Math.random() * 60,
                h: 20
            });
        }

        state.obstacles.forEach(o => o.y += state.speed);
        state.obstacles = state.obstacles.filter(o => o.y < GAME_HEIGHT);

        const inputs = new Float32Array(state.cars.length * 5);
        const angles = [-0.5, -0.25, 0, 0.25, 0.5]; 

        state.cars.forEach((car, idx) => {
            if (car.dead) return;

            for (let i = 0; i < 5; i++) {
                let dist = 1.0; 
                const angle = angles[i]; 
                
                for (let obs of state.obstacles) {
                    let dx = (obs.x + obs.w/2) - car.x;
                    let dy = obs.y - car.y;
                    
                    let d = Math.sqrt(dx*dx + dy*dy);
                    let normD = Math.max(0, Math.min(1, d / GAME_HEIGHT));
                    
                    if (angle < 0 && dx > 20) continue;
                    if (angle > 0 && dx < -20) continue;
                    if (angle === 0 && Math.abs(dx) > 40) continue;

                    if (normD < dist) dist = normD;
                }
                inputs[idx * 5 + i] = dist;
            }
            car.fitness += 1; 
        });

        if (!isComputing.current) {
            isComputing.current = true;
            try {
                const outputs = computeAll(inputs);
                if (outputs) {
                    state.cars.forEach((car, idx) => {
                        if (car.dead) return;
                        const steering = outputs[idx];
                        const move = (steering - 0.5) * 2.0 * 5.0;
                        car.x += move;
                        car.x = Math.max(0, Math.min(GAME_WIDTH - PLAYER_SIZE, car.x));
                    });
                }
            } catch(e) {
                console.error("Compute Error:", e);
            } finally {
                isComputing.current = false;
            }
        }

        state.cars.forEach(car => {
            if (car.dead) return;
            const playerRect = { x: car.x, y: car.y, w: PLAYER_SIZE, h: PLAYER_SIZE };
            const hit = state.obstacles.some(o => 
                playerRect.x < o.x + o.w &&
                playerRect.x + playerRect.w > o.x &&
                playerRect.y < o.y + o.h &&
                playerRect.y + playerRect.h > o.y
            ) || car.x <= 0 || car.x >= GAME_WIDTH - PLAYER_SIZE;

            if (hit) car.dead = true;
        });
    }, [computeAll, evolveParams, setStats]);

    return {
        gameState,
        resetGame,
        updatePhysics
    };
}
