import * as wasm from '../../wasm/pkg/gran_prix_wasm';
import { ensureWasmLoaded } from '../../lib/wasmLoader';

export interface BaseAgent {
    id: number;
    popId: string;
    dead: boolean;
    fitness: number;
    color: string;
}

export interface SimulationState<TAgent extends BaseAgent> {
    agents: TAgent[];
    frame: number;
    generation: number;
    isComputing: boolean;
}

export interface PopulationConfig {
    id: string;
    size: number;
    inputs: number;
    outputs: number;
    hidden: number[];
}

export interface SimulationConfig<TAgent extends BaseAgent, TState extends SimulationState<TAgent>, TStats> {
    populations: PopulationConfig[];
    
    // Lifecycle hooks
    createAgent: (id: number, popId: string) => TAgent;
    onReset?: (state: TState) => void; // New: for environment init
    updatePhysics: (state: TState, outputs: Map<string, Float32Array | null>) => void;
    getInputs: (state: TState, popId: string) => Float32Array;
    getStats: (state: TState) => TStats;
    
    // Evolution settings (optional defaults)
    mutationRate?: number;
    mutationScale?: number;
    mutationStrategy?: wasm.MutationStrategy;
}

/**
 * Staff-Level Generic Simulation Engine (Multi-Population / Co-Evolution)
 */
export class SimulationEngine<TAgent extends BaseAgent, TState extends SimulationState<TAgent>, TStats> {
    public state: TState;
    public populations: Map<string, wasm.Population> = new Map();
    
    constructor(private config: SimulationConfig<TAgent, TState, TStats>) {
        this.state = {
            agents: [],
            frame: 0,
            generation: 1,
            isComputing: false,
        } as unknown as TState;
    }

    async init() {
        await ensureWasmLoaded();
        for (const popConfig of this.config.populations) {
            const pop = new wasm.Population(
                popConfig.size,
                popConfig.inputs,
                new Uint32Array(popConfig.hidden),
                popConfig.outputs
            );
            this.populations.set(popConfig.id, pop);
        }
        this.reset();
    }

    reset() {
        this.state.agents = [];
        for (const popConfig of this.config.populations) {
            for (let i = 0; i < popConfig.size; i++) {
                this.state.agents.push(this.config.createAgent(i, popConfig.id));
            }
        }
        this.state.frame = 0;
        if (this.config.onReset) {
            this.config.onReset(this.state);
        }
    }

    tick() {
        if (this.populations.size === 0) return;

        const alive = this.state.agents.filter(a => !a.dead);
        // Specialized end condition can be handled in updatePhysics or here
        // If all dead (across all populations), evolve everything.
        if (alive.length === 0) {
            this.evolve();
            return;
        }

        this.state.frame++;

        const outputsMap = new Map<string, Float32Array | null>();
        
        if (!this.state.isComputing) {
            this.state.isComputing = true;
            try {
                for (const [id, pop] of this.populations) {
                    const inputs = this.config.getInputs(this.state, id);
                    outputsMap.set(id, pop.compute_all(inputs));
                }
            } catch (e) {
                console.error("SimulationEngine: WASM Compute Error", e);
            } finally {
                this.state.isComputing = false;
            }
        }

        // Physics Update
        this.config.updatePhysics(this.state, outputsMap);
    }

    evolve() {
        for (const [id, pop] of this.populations) {
            const popAgents = this.state.agents.filter(a => (a as any).popId === id);
            const scores = popAgents.map(a => a.fitness);
            
            pop.evolve(
                Float32Array.from(scores),
                this.config.mutationRate ?? 0.15,
                this.config.mutationScale ?? 0.5,
                this.config.mutationStrategy ?? wasm.MutationStrategy.Additive
            );
        }

        this.state.generation++;
        this.reset();
    }

    getStats(): TStats {
        return this.config.getStats(this.state);
    }
    
    get_best_brain_snapshot(popId: string, fitnessScores: number[]): any[] | null {
        const pop = this.populations.get(popId);
        if (!pop) return null;
        return pop.get_best_brain_snapshot(Float32Array.from(fitnessScores));
    }

    get fitnessScores(): Map<string, Float32Array> {
        const scores = new Map<string, Float32Array>();
        for (const [id] of this.populations) {
            const popAgents = this.state.agents.filter(a => (a as any).popId === id);
            scores.set(id, Float32Array.from(popAgents.map(a => a.fitness)));
        }
        return scores;
    }
}
