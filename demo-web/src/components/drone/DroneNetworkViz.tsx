import React from 'react';
import * as wasm from '../../wasm/pkg/gran_prix_wasm';
import { DRONE_INPUTS, DRONE_HIDDEN, DRONE_OUTPUTS } from '../../types';
import { NetworkViz } from '../shared/NetworkViz';

interface DroneNetworkVizProps {
    population: wasm.Population | null;
    fitnessScores: Float32Array;
}

export const DroneNetworkViz: React.FC<DroneNetworkVizProps> = ({
    population,
    fitnessScores,
}) => {
    return (
        <NetworkViz
            population={population}
            fitnessScores={fitnessScores}
            inputs={DRONE_INPUTS}
            hidden={DRONE_HIDDEN}
            outputs={DRONE_OUTPUTS}
            height={200}
            width={280}
        />
    );
};
