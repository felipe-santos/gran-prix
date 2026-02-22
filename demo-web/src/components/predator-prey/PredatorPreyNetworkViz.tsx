import React from 'react';
import * as wasm from '../../wasm/pkg/gran_prix_wasm';
import { 
    PREDATOR_INPUTS, PREDATOR_HIDDEN, PREDATOR_OUTPUTS,
    PREY_INPUTS, PREY_HIDDEN, PREY_OUTPUTS 
} from '../../types';
import { NetworkViz } from '../shared/NetworkViz';

interface PredatorPreyNetworkVizProps {
    predatorPopulation: wasm.Population | null;
    preyPopulation: wasm.Population | null;
    predatorFitness?: Float32Array;
    preyFitness?: Float32Array;
    predatorHidden?: number[];
    preyHidden?: number[];
}

export const PredatorPreyNetworkViz: React.FC<PredatorPreyNetworkVizProps> = ({
    predatorPopulation,
    preyPopulation,
    predatorFitness,
    preyFitness,
    predatorHidden = PREDATOR_HIDDEN,
    preyHidden = PREY_HIDDEN,
}) => {
    return (
        <div className="grid grid-cols-2 gap-4">
            <NetworkViz
                population={predatorPopulation}
                fitnessScores={predatorFitness || new Float32Array()}
                inputs={PREDATOR_INPUTS}
                hidden={predatorHidden}
                outputs={PREDATOR_OUTPUTS}
                height={200}
                width={200}
            />
            <NetworkViz
                population={preyPopulation}
                fitnessScores={preyFitness || new Float32Array()}
                inputs={PREY_INPUTS}
                hidden={preyHidden}
                outputs={PREY_OUTPUTS}
                height={200}
                width={200}
            />
        </div>
    );
};
