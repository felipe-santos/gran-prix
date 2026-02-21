import React from 'react';
import * as wasm from '../../wasm/pkg/gran_prix_wasm';
import { GRID_INPUTS, GRID_HIDDEN, GRID_OUTPUTS } from '../../types';
import { NetworkViz } from '../shared/NetworkViz';

interface SmartGridNetworkVizProps {
    population: wasm.Population | null;
    fitnessScores: Float32Array;
}

export const SmartGridNetworkViz: React.FC<SmartGridNetworkVizProps> = ({
    population,
    fitnessScores,
}) => {
    return (
        <NetworkViz
            population={population}
            fitnessScores={fitnessScores}
            inputs={GRID_INPUTS}
            hidden={GRID_HIDDEN}
            outputs={GRID_OUTPUTS}
            height={200}
            width={280}
        />
    );
};
