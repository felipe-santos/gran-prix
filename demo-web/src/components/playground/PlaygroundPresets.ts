export interface DataPoint {
    x: number;
    y: number;
    label: number;
}

export interface Preset {
    id: string;
    name: string;
    description: string;
    explanation: string;
    points: DataPoint[];
    recommendedArch: number[];
}

export const PRESETS: Preset[] = [
    {
        id: 'linear',
        name: 'Separação Linear',
        description: 'Dois grupos de pontos que podem ser divididos por uma única linha reta.',
        explanation: 'Este é o caso mais simples. Uma rede neural sem camadas ocultas (um Perceptron) consegue resolver isso facilmente, pois a fronteira de decisão é uma função linear (uma linha).',
        recommendedArch: [],
        points: [
            { x: -0.5, y: -0.5, label: 0 }, { x: -0.7, y: -0.3, label: 0 }, { x: -0.3, y: -0.8, label: 0 },
            { x: -0.8, y: -0.1, label: 0 }, { x: -0.4, y: -0.6, label: 0 },
            { x: 0.5, y: 0.5, label: 1 }, { x: 0.7, y: 0.3, label: 1 }, { x: 0.3, y: 0.8, label: 1 },
            { x: 0.8, y: 0.1, label: 1 }, { x: 0.4, y: 0.6, label: 1 },
        ]
    },
    {
        id: 'xor',
        name: 'Padrão XOR',
        description: 'Os pontos estão cruzados, impedindo uma divisão por uma única reta.',
        explanation: 'O problema do XOR foi o que causou o "primeiro inverno da IA". Ele demonstra que funções não-lineares exigem camadas ocultas. Para resolver isso, a rede precisa de pelo menos uma camada oculta (ex: [4]) para "dobrar" o espaço e criar duas linhas de corte.',
        recommendedArch: [4],
        points: [
            { x: -0.5, y: -0.5, label: 0 }, { x: -0.6, y: -0.4, label: 0 }, { x: -0.4, y: -0.6, label: 0 },
            { x: 0.5, y: 0.5, label: 0 }, { x: 0.6, y: 0.4, label: 0 }, { x: 0.4, y: 0.6, label: 0 },
            { x: -0.5, y: 0.5, label: 1 }, { x: -0.6, y: 0.4, label: 1 }, { x: -0.4, y: 0.6, label: 1 },
            { x: 0.5, y: -0.5, label: 1 }, { x: 0.6, y: -0.4, label: 1 }, { x: 0.4, y: -0.6, label: 1 },
        ]
    },
    {
        id: 'circles',
        name: 'Círculos Concêntricos',
        description: 'Um círculo de pontos dentro de outro círculo.',
        explanation: 'Aqui a rede precisa criar uma fronteira fechada (um anel). Isso exige mais neurônios e profundidade (ex: [8, 8]) para que a combinação das funções de ativação consiga cercar o centro com precisão.',
        recommendedArch: [8, 8],
        points: [
            // Inner circle (Class 0)
            { x: 0, y: 0, label: 0 }, { x: 0.1, y: 0.1, label: 0 }, { x: -0.1, y: -0.1, label: 0 },
            { x: 0.1, y: -0.1, label: 0 }, { x: -0.1, y: 0.1, label: 0 }, { x: 0.2, y: 0, label: 0 },
            { x: -0.2, y: 0, label: 0 }, { x: 0, y: 0.2, label: 0 }, { x: 0, y: -0.2, label: 0 },
            // Outer circle (Class 1)
            { x: 0.7, y: 0, label: 1 }, { x: -0.7, y: 0, label: 1 }, { x: 0, y: 0.7, label: 1 },
            { x: 0, y: -0.7, label: 1 }, { x: 0.5, y: 0.5, label: 1 }, { x: -0.5, y: -0.5, label: 1 },
            { x: 0.5, y: -0.5, label: 1 }, { x: -0.5, y: 0.5, label: 1 },
            { x: 0.6, y: 0.3, label: 1 }, { x: -0.6, y: -0.3, label: 1 }, { x: 0.3, y: 0.6, label: 1 },
            { x: -0.3, y: -0.6, label: 1 },
        ]
    },
    {
        id: 'moons',
        name: 'Luas Entrelaçadas',
        description: 'Duas formas em meia-lua que se encaixam de forma complexa.',
        explanation: 'Este padrão testa a capacidade da rede de aprender curvas suaves e complexas. É um ótimo exemplo de como a retropropagação (backprop) ajusta os pesos para "esculpir" a solução no espaço de características.',
        recommendedArch: [8, 8],
        points: [
            // Top moon (Class 0)
            { x: -0.5, y: 0.2, label: 0 }, { x: -0.4, y: 0.35, label: 0 }, { x: -0.2, y: 0.45, label: 0 },
            { x: 0, y: 0.5, label: 0 }, { x: 0.2, y: 0.45, label: 0 }, { x: 0.4, y: 0.35, label: 0 },
            { x: 0.5, y: 0.2, label: 0 },
            // Bottom moon (Class 1)
            { x: 0, y: -0.1, label: 1 }, { x: 0.1, y: -0.2, label: 1 }, { x: 0.3, y: -0.3, label: 1 },
            { x: 0.5, y: -0.35, label: 1 }, { x: 0.7, y: -0.3, label: 1 }, { x: 0.9, y: -0.2, label: 1 },
            { x: 1.0, y: -0.1, label: 1 },
        ]
    }
];
