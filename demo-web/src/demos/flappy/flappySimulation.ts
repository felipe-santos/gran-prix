import * as wasm from '../../wasm/pkg/gran_prix_wasm';
import { 
    FLAPPY_WIDTH, 
    FLAPPY_HEIGHT, 
    FLAPPY_POPULATION_SIZE, 
    FLAPPY_INPUTS, 
    FLAPPY_OUTPUTS,
    FlappyStats,
    FlappyBird,
    FlappyPipe
} from '../../types';
import { SimulationConfig, SimulationState } from '../../core/simulation/SimulationEngine';
import { checkCollision } from '../../core/physics';

export interface FlappySimulationState extends SimulationState<FlappyBird> {
    pipes: FlappyPipe[];
    score: number;
    speed: number;
}

function createPipe(x: number): FlappyPipe {
    const margin = 100;
    const gapHeight = 160;
    const topHeight = margin + Math.random() * (FLAPPY_HEIGHT - gapHeight - margin * 2);
    return {
        x,
        width: 60,
        topHeight,
        passed: false
    };
}

export const flappySimulationConfig: SimulationConfig<FlappyBird, FlappySimulationState, FlappyStats> = {
    populations: [
        {
            id: 'main',
            size: FLAPPY_POPULATION_SIZE,
            inputs: FLAPPY_INPUTS,
            outputs: FLAPPY_OUTPUTS,
            hidden: [8]
        }
    ],

    createAgent: (id, popId) => ({
        id,
        popId,
        x: FLAPPY_WIDTH / 4,
        y: FLAPPY_HEIGHT / 2,
        vy: 0,
        dead: false,
        fitness: 0,
        color: `hsl(${(id / FLAPPY_POPULATION_SIZE) * 360}, 70%, 60%)`,
    }),

    onReset: (state) => {
        state.pipes = [];
        state.score = 0;
        state.speed = 3.5;
        state.agents.forEach(bird => {
            bird.x = 50;
            bird.y = FLAPPY_HEIGHT / 2;
            bird.vy = 0;
            bird.dead = false;
        });
    },

    getInputs: (state, _popId) => {
        const inputs = new Float32Array(FLAPPY_POPULATION_SIZE * FLAPPY_INPUTS);
        state.agents.forEach((bird, idx) => {
            if (bird.dead) return;
            
            const nextPipe = state.pipes.find(p => p.x + p.width > bird.x) || state.pipes[0];
            
            inputs[idx * FLAPPY_INPUTS + 0] = bird.y / FLAPPY_HEIGHT;
            inputs[idx * FLAPPY_INPUTS + 1] = bird.vy / 10.0;
            inputs[idx * FLAPPY_INPUTS + 2] = (nextPipe.x - bird.x) / FLAPPY_WIDTH;
            inputs[idx * FLAPPY_INPUTS + 3] = nextPipe.topHeight / FLAPPY_HEIGHT;
            inputs[idx * FLAPPY_INPUTS + 4] = (nextPipe.topHeight + 160) / FLAPPY_HEIGHT;
        });
        return inputs;
    },

    updatePhysics: (state, outputsMap) => {
        const outputs = outputsMap.get('main');
        
        // 1. Update Pipes
        if (state.pipes.length === 0 || state.pipes[state.pipes.length - 1].x < FLAPPY_WIDTH - 250) {
            state.pipes.push(createPipe(FLAPPY_WIDTH));
        }
        
        state.pipes.forEach(pipe => pipe.x -= state.speed);
        state.pipes = state.pipes.filter(pipe => pipe.x + pipe.width > 0);

        // 2. Update Birds
        state.agents.forEach((bird, idx) => {
            if (bird.dead) return;

            // Apply WASM thrust
            if (outputs && outputs[idx * FLAPPY_OUTPUTS] > 0.5) {
                bird.vy = -5.5;
            }

            bird.vy += 0.25; // gravity
            bird.y += bird.vy;
            bird.fitness += 0.1;

            // Collision
            if (bird.y < 0 || bird.y > FLAPPY_HEIGHT) bird.dead = true;
            
            const birdAABB = {
                x: bird.x - 15,
                y: bird.y - 15,
                width: 30,
                height: 30
            };

            for (const pipe of state.pipes) {
                const topAABB = { x: pipe.x, y: 0, width: pipe.width, height: pipe.topHeight };
                const bottomAABB = { x: pipe.x, y: pipe.topHeight + 160, width: pipe.width, height: FLAPPY_HEIGHT - pipe.topHeight - 160 };

                if (checkCollision(birdAABB, topAABB) || checkCollision(birdAABB, bottomAABB)) {
                    bird.dead = true;
                    break;
                }
                
                if (!bird.dead && pipe.x + pipe.width < bird.x && pipe.x + pipe.width > bird.x - state.speed) {
                    bird.fitness += 20;
                }
            }
        });

        const alive = state.agents.filter(a => !a.dead);
        if (alive.length > 0) {
            state.score = Math.floor(alive[0].fitness / 20);
        }
    },

    getStats: (state) => ({
        generation: state.generation,
        best: state.agents.length > 0 ? Math.max(...state.agents.map(a => a.fitness)) : 0,
        alive: state.agents.filter(a => !a.dead).length,
        score: state.score
    }),

    mutationRate: 0.1,
    mutationScale: 0.5,
    mutationStrategy: wasm.MutationStrategy.Additive,
};
