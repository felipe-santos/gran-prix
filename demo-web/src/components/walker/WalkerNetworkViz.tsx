import React from 'react';
import * as wasm from '../../wasm/pkg/gran_prix_wasm';
import { WALKER_INPUTS, WALKER_HIDDEN, WALKER_OUTPUTS } from '../../types';
import { NetworkViz } from '../shared/NetworkViz';

interface WalkerNetworkVizProps {
    population: wasm.Population | null;
    fitnessScores: Float32Array;
}

export const WalkerNetworkViz: React.FC<WalkerNetworkVizProps> = ({
    population,
    fitnessScores,
}) => {
    return (
        <NetworkViz
            population={population}
            fitnessScores={fitnessScores}
            inputs={WALKER_INPUTS}
            hidden={WALKER_HIDDEN}
            outputs={WALKER_OUTPUTS}
            height={200}
            width={280}
        />
    );
};
