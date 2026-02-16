import React from 'react';
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
} from 'recharts';

export interface PerformanceData {
  generation: number;
  avg: number;
  max: number;
}

interface PerformanceChartsProps {
  data: PerformanceData[];
}

export const PerformanceCharts: React.FC<PerformanceChartsProps> = ({ data }) => {
  if (data.length === 0) return null;

  return (
    <div className="w-full h-64 bg-card/50 border border-border rounded-2xl p-6 backdrop-blur-md animate-in fade-in slide-in-from-bottom duration-700">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h3 className="text-[10px] font-bold text-foreground uppercase tracking-widest">Evolution Progress</h3>
          <p className="text-[8px] text-muted-foreground font-mono uppercase">Fitness_Telemetry_Pipeline</p>
        </div>
        <div className="flex gap-4">
           <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
              <span className="text-[9px] font-bold text-muted-foreground uppercase">Max Fitness</span>
           </div>
           <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-500"></span>
              <span className="text-[9px] font-bold text-muted-foreground uppercase">Average</span>
           </div>
        </div>
      </div>
      
      <ResponsiveContainer width="100%" height="80%">
        <LineChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} opacity={0.2} />
          <XAxis 
            dataKey="generation" 
            stroke="var(--muted-foreground)" 
            fontSize={9} 
            tickLine={false} 
            axisLine={false}
            label={{ value: 'Generation', position: 'insideBottom', offset: -5, fontSize: 8, fill: 'var(--muted-foreground)' }}
          />
          <YAxis 
            stroke="var(--muted-foreground)" 
            fontSize={9} 
            tickLine={false} 
            axisLine={false}
            tickFormatter={(value) => value.toFixed(0)}
          />
          <Tooltip 
            contentStyle={{ 
              backgroundColor: 'var(--card)', 
              borderColor: 'var(--border)', 
              borderRadius: '12px',
              fontSize: '10px',
              boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)'
            }}
            itemStyle={{ fontSize: '10px', fontWeight: 'bold' }}
            labelStyle={{ color: 'var(--foreground)', marginBottom: '4px' }}
          />
          <Line 
            type="monotone" 
            dataKey="max" 
            stroke="#10b981" 
            strokeWidth={2} 
            dot={{ r: 2, fill: '#10b981' }} 
            activeDot={{ r: 4, strokeWidth: 0 }}
            isAnimationActive={false}
          />
          <Line 
            type="monotone" 
            dataKey="avg" 
            stroke="#3b82f6" 
            strokeWidth={2} 
            dot={{ r: 2, fill: '#3b82f6' }} 
            activeDot={{ r: 4, strokeWidth: 0 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};
