import React from 'react';
import * as wasm from '@gran-prix/wasm';
import { TRADER_INPUTS, TRADER_HIDDEN, TRADER_OUTPUTS } from '../../types';
import { NetworkViz } from '../shared/NetworkViz';

interface TraderNetworkVizProps {
    population: wasm.Population | null;
    fitnessScores?: Float32Array;
    hidden?: number[];
}

const OUTPUT_NAMES = ['Buy📈', 'Sell📉', 'Hold⏸️'];

export const TraderNetworkViz: React.FC<TraderNetworkVizProps> = ({
    population,
    fitnessScores,
    hidden = TRADER_HIDDEN,
}) => {
    return (
        <NetworkViz
            population={population}
            fitnessScores={fitnessScores || new Float32Array()}
            inputs={TRADER_INPUTS}
            hidden={hidden}
            outputs={TRADER_OUTPUTS}
            outputNames={OUTPUT_NAMES}
            height={240}
            width={300}
        />
    );
};
