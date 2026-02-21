import React from 'react';
import * as wasm from '../../wasm/pkg/gran_prix_wasm';
import { FLAPPY_INPUTS, FLAPPY_HIDDEN } from '../../types';
import { NetworkViz } from '../shared/NetworkViz';

interface FlappyNetworkVizProps {
    population: wasm.Population | null;
    fitnessScores: Float32Array;
    inputs?: number;
    hidden?: number[];
    outputs?: number;
}

export const FlappyNetworkViz: React.FC<FlappyNetworkVizProps> = ({
    population,
    fitnessScores,
    inputs = FLAPPY_INPUTS,
    hidden = FLAPPY_HIDDEN,
    outputs = 1,
}) => {
    return (
        <NetworkViz
            population={population}
            fitnessScores={fitnessScores}
            inputs={inputs}
            hidden={hidden}
            outputs={outputs}
            height={200}
            width={280}
        />
    );
};
