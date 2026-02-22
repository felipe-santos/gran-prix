import React from 'react';
import * as wasm from '../../wasm/pkg/gran_prix_wasm';
import { VACUUM_INPUTS, VACUUM_HIDDEN, VACUUM_OUTPUTS } from '../../types';
import { NetworkViz } from '../shared/NetworkViz';

interface VacuumNetworkVizProps {
    population: wasm.Population | null;
    fitnessScores?: Float32Array;
    hidden?: number[];
}

const INPUT_NAMES = [
    'dust_fwd', 'dust_left', 'dust_right',
    'obs_fwd', 'battery',
    'dist_⚡', 'ang_⚡',
    'sin(θ)', 'cos(θ)',
];
const OUTPUT_NAMES = ['fwd', 'turn_L', 'turn_R'];

export const VacuumNetworkViz: React.FC<VacuumNetworkVizProps> = ({
    population,
    fitnessScores,
    hidden = VACUUM_HIDDEN,
}) => {
    return (
        <NetworkViz
            population={population}
            fitnessScores={fitnessScores || new Float32Array()}
            inputs={VACUUM_INPUTS}
            hidden={hidden}
            outputs={VACUUM_OUTPUTS}
            inputNames={INPUT_NAMES}
            outputNames={OUTPUT_NAMES}
            height={320}
        />
    );
};
