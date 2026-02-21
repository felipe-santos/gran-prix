const INPUT_LABELS = ['Return', 'RSI', 'SMA×', 'ATR', 'Pos', 'P&L', 'DD'];
const OUTPUT_LABELS = ['Buy', 'Sell', 'Hold'];

interface TraderNetworkVizProps {
    snapshot: any;
}

export const TraderNetworkViz = ({ snapshot }: TraderNetworkVizProps) => {
    if (!snapshot) return null;

    const nodes: { id: number; layer: number; value: number; label?: string }[] = [];
    const links: { from: number; to: number; weight: number }[] = [];

    try {
        const data = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
        if (Array.isArray(data)) {
            data.forEach((n: any) => nodes.push(n));
        }
    } catch {
        return null;
    }

    if (nodes.length === 0) return null;

    const inputNodes = nodes.filter(n => n.layer === 0);
    const outputNodes = nodes.filter(n => n.layer === Math.max(...nodes.map(n => n.layer)));

    inputNodes.forEach((n, i) => {
        if (i < INPUT_LABELS.length) n.label = INPUT_LABELS[i];
    });
    outputNodes.forEach((n, i) => {
        if (i < OUTPUT_LABELS.length) n.label = OUTPUT_LABELS[i];
    });

    const width = 360;
    const height = 240;
    const layers = [...new Set(nodes.map(n => n.layer))].sort();
    const layerX = layers.reduce((acc, l, i) => {
        acc[l] = 40 + (i / Math.max(1, layers.length - 1)) * (width - 80);
        return acc;
    }, {} as Record<number, number>);

    const layerNodes = layers.map(l => nodes.filter(n => n.layer === l));
    const positions: Record<number, { x: number; y: number }> = {};

    layerNodes.forEach((lnodes, li) => {
        const l = layers[li];
        const gap = height / (lnodes.length + 1);
        lnodes.forEach((n, i) => {
            positions[n.id] = { x: layerX[l], y: gap * (i + 1) };
        });
    });

    for (let li = 0; li < layers.length - 1; li++) {
        const fromLayer = layerNodes[li];
        const toLayer = layerNodes[li + 1];
        fromLayer.forEach(from => {
            toLayer.forEach(to => {
                links.push({ from: from.id, to: to.id, weight: Math.random() * 2 - 1 });
            });
        });
    }

    return (
        <div className="bg-card/50 border border-border rounded-2xl p-4 backdrop-blur-md">
            <h3 className="text-[10px] font-bold text-foreground uppercase tracking-widest mb-3">
                Best Trader Brain
            </h3>
            <svg width={width} height={height} className="w-full" viewBox={`0 0 ${width} ${height}`}>
                {links.map((link, i) => {
                    const from = positions[link.from];
                    const to = positions[link.to];
                    if (!from || !to) return null;
                    const opacity = Math.min(1, Math.abs(link.weight));
                    const color = link.weight > 0 ? '#10b981' : '#ef4444';
                    return (
                        <line
                            key={i}
                            x1={from.x} y1={from.y}
                            x2={to.x} y2={to.y}
                            stroke={color}
                            strokeWidth={0.5 + Math.abs(link.weight)}
                            opacity={opacity * 0.3}
                        />
                    );
                })}
                {nodes.map(node => {
                    const pos = positions[node.id];
                    if (!pos) return null;
                    const isInput = node.layer === 0;
                    const isOutput = node.layer === Math.max(...layers);
                    const r = isInput || isOutput ? 8 : 5;
                    const fill = isOutput
                        ? (node.label === 'Buy' ? '#10b981' : node.label === 'Sell' ? '#ef4444' : '#64748b')
                        : isInput
                            ? '#3b82f6'
                            : '#64748b';

                    return (
                        <g key={node.id}>
                            <circle cx={pos.x} cy={pos.y} r={r} fill={fill} opacity={0.85} />
                            {node.label && (
                                <text
                                    x={isInput ? pos.x - 12 : pos.x + 12}
                                    y={pos.y + 3}
                                    textAnchor={isInput ? 'end' : 'start'}
                                    fontSize={7}
                                    fill="var(--muted-foreground)"
                                    fontWeight="bold"
                                >
                                    {node.label}
                                </text>
                            )}
                        </g>
                    );
                })}
            </svg>
        </div>
    );
};
