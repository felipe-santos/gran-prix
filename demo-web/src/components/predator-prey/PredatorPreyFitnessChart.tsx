import React from 'react';
import { PerformanceCharts, PerformanceData } from '../PerformanceCharts';

interface PredatorPreyFitnessChartProps {
    data: PerformanceData[];
}

export const PredatorPreyFitnessChart: React.FC<PredatorPreyFitnessChartProps> = ({ data }) => {
    return <PerformanceCharts data={data} />;
};
