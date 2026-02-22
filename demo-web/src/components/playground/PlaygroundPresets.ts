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
        name: 'Linear Separation',
        description: 'Two groups of points that can be divided by a single straight line.',
        explanation: 'This is the simplest case. A neural network with no hidden layers (a Perceptron) can solve this easily, as the decision boundary is a linear function.',
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
        name: 'XOR Pattern',
        description: 'Points are crossed, preventing a division by a single straight line.',
        explanation: 'The XOR problem caused the "first AI winter". It demonstrates that non-linear functions require hidden layers. To solve this, the network needs at least one hidden layer (e.g., [4]) to "warp" the space.',
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
        name: 'Concentric Circles',
        description: 'A circle of points inside another circle.',
        explanation: 'Here the network needs to create a closed boundary (a ring). This requires more neurons and depth (e.g., [8, 8]) so the combination of activation functions can accurately surround the center.',
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
        name: 'Intertwined Moons',
        description: 'Two interlocking crescent shapes.',
        explanation: 'This pattern tests the network\'s ability to learn smooth, complex curves. It is a great example of how backpropagation carves the solution into the feature space.',
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
