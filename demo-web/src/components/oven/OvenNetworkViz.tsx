import React from 'react';
import * as wasm from '../../wasm/pkg/gran_prix_wasm';
import { OVEN_INPUTS, OVEN_HIDDEN, OVEN_OUTPUTS } from '../../types';
import { NetworkViz } from '../shared/NetworkViz';

interface OvenNetworkVizProps {
    population: wasm.Population | null;
    fitnessScores: Float32Array;
}

const INPUT_NAMES = [
    'Air', 'Surf', 'Core', 'Tgt_err', 'Brn_err', 'Time%',
    'Cake', 'Bread', 'Turkey', 'Pizza', 'Moist'
];
const OUTPUT_NAMES = ['Top🔥', 'Bot🔥', 'Fan🌬️'];

export const OvenNetworkViz: React.FC<OvenNetworkVizProps> = ({
    population,
    fitnessScores,
}) => {
    return (
        <NetworkViz
            population={population}
            fitnessScores={fitnessScores}
            inputs={OVEN_INPUTS}
            hidden={OVEN_HIDDEN}
            outputs={OVEN_OUTPUTS}
            inputNames={INPUT_NAMES}
            outputNames={OUTPUT_NAMES}
        />
    );
};
