import React from 'react';
import { PerformanceCharts, PerformanceData } from '../PerformanceCharts';

interface FlappyFitnessChartProps {
    data: PerformanceData[];
}

/**
 * Fitness evolution chart for the Flappy Bird demo.
 *
 * This is a thin semantic wrapper around the existing PerformanceCharts
 * component — reusing it avoids duplicating charting logic and keeps a
 * single source of truth for the recharts setup (animations, tooltip styles,
 * axis formatting).
 *
 * The parent (FlappyDemo) maps its generational data directly to PerformanceData
 * so no adaptation layer is needed here.
 */
export const FlappyFitnessChart: React.FC<FlappyFitnessChartProps> = ({ data }) => {
    return <PerformanceCharts data={data} />;
};
