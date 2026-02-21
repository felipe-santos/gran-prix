import React from 'react';
import { PerformanceCharts, PerformanceData } from '../PerformanceCharts';

interface WalkerFitnessChartProps {
    data: PerformanceData[];
}

/**
 * Fitness evolution chart for the Bipedal Walker demo.
 *
 * Thin semantic wrapper around the existing PerformanceCharts
 * component — reusing it avoids duplicating charting logic and keeps a
 * single source of truth for the recharts setup.
 *
 * The parent (WalkerDemo) maps its generational data directly to PerformanceData
 * so no adaptation layer is needed.
 */
export const WalkerFitnessChart: React.FC<WalkerFitnessChartProps> = ({ data }) => {
    return <PerformanceCharts data={data} />;
};
