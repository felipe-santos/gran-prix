import React from 'react';
import * as wasm from '../../wasm/pkg/gran_prix_wasm';
import { GRID_INPUTS, GRID_HIDDEN, GRID_OUTPUTS } from '../../types';
import { NetworkViz } from '../shared/NetworkViz';

interface SmartGridNetworkVizProps {
    population: wasm.Population | null;
    fitnessScores?: Float32Array;
    hidden?: number[];
}

export const SmartGridNetworkViz: React.FC<SmartGridNetworkVizProps> = ({
    population,
    fitnessScores,
    hidden = GRID_HIDDEN,
}) => {
    return (
        <NetworkViz
            population={population}
            fitnessScores={fitnessScores || new Float32Array()}
            inputs={GRID_INPUTS}
            hidden={hidden}
            outputs={GRID_OUTPUTS}
            height={200}
            width={280}
        />
    );
};
