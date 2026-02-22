export type DemoId =
    | 'oven'
    | 'vacuum'
    | 'trader'
    | 'smart-grid'
    | 'drone'
    | 'predator-prey'
    | 'walker'
    | 'flappy'
    | 'evolution'
    | 'training';

export interface DemoMetadata {
    id: DemoId;
    title: string;
    subtitle: string;
    description: string;
    tags: string[];
    icon: string;
    color: string; // Tailwind color class for the glowing accent
}

export const DEMOS: DemoMetadata[] = [
    {
        id: 'oven',
        title: 'Smart Oven IoT',
        subtitle: 'Edge AI Thermodynamics Control',
        description: 'Redes neurais operando como controladores PID avançados rodando no limite do sensor para assar perfeitamente diferentes tipos de alimentos.',
        tags: ['PID', 'Thermodynamics', 'Edge AI'],
        icon: '🍳',
        color: 'from-orange-500 to-red-500',
    },
    {
        id: 'vacuum',
        title: 'Smart Vacuum',
        subtitle: 'Autonomous Spatial Coverage',
        description: 'Agentes robóticos aprendem a navegar, mapear e limpar uma sala com obstáculos mantendo eficiência energética.',
        tags: ['Spatial', 'Pathfinding', 'Energy'],
        icon: '🤖',
        color: 'from-blue-400 to-indigo-500',
    },
    {
        id: 'trader',
        title: 'AI Trader',
        subtitle: 'Market Simulation & Prediction',
        description: 'Evolução de estratégias de trading com leitura de indicadores técnicos (RSI, SMA) em um mercado simulado (GBM).',
        tags: ['Finance', 'Time Series', 'Evolution'],
        icon: '📈',
        color: 'from-emerald-400 to-teal-500',
    },
    {
        id: 'smart-grid',
        title: 'Smart Grid',
        subtitle: 'Energy Optimization Routing',
        description: 'Otimização descentralizada de distribuição de energia solar, baterias e demanda urbana flutuante.',
        tags: ['Logistics', 'Optimization', 'Grid'],
        icon: '⚡',
        color: 'from-yellow-400 to-amber-500',
    },
    {
        id: 'drone',
        title: 'Drone Stabilizer',
        subtitle: '6-DOF Attitude Control',
        description: 'Treinamento de drones com múltiplos propulsores para manter estabilidade e alcançar waypoints sob ventos imprevisíveis.',
        tags: ['Physics', 'Control Theory', '6-DOF'],
        icon: '🚁',
        color: 'from-cyan-400 to-blue-500',
    },
    {
        id: 'predator-prey',
        title: 'Predator vs Prey',
        subtitle: 'Co-evolutionary Arms Race',
        description: 'Duas populações de redes neurais evoluem simultaneamente: raposas aprendem a caçar, coelhos aprendem a fugir.',
        tags: ['Co-evolution', 'Multi-Agent', 'Survival'],
        icon: '🦊',
        color: 'from-rose-400 to-red-600',
    },
    {
        id: 'walker',
        title: 'Bipedal Walker',
        subtitle: 'Articulated Physics Locomotion',
        description: 'Aprendizado de marcha (gait) para um robô bípede em terreno irregular utilizando limites de juntas.',
        tags: ['Physics', 'Locomotion', 'Joints'],
        icon: '🦵',
        color: 'from-stone-400 to-stone-600',
    },
    {
        id: 'flappy',
        title: 'Flappy Bird RL',
        subtitle: 'Classic Reinforcement Learning',
        description: 'O clássico: redes neurais que aprendem a desviar de canos variados calculando distância horizontal e vertical.',
        tags: ['Classic RL', 'Vision', 'Timing'],
        icon: '🐦',
        color: 'from-yellow-300 to-green-500',
    },
    {
        id: 'evolution',
        title: 'Car Evolution',
        subtitle: 'Genetic Algorithm Basics',
        description: 'Nossa engine original: carros aprendendo a dirigir por uma pista com base em sensores de distância lidando com colisões.',
        tags: ['Raycasting', 'Vehicles', 'Genesis'],
        icon: '🏎️',
        color: 'from-red-500 to-rose-600',
    },
    {
        id: 'training',
        title: 'Backprop Classifier',
        subtitle: 'Core Supervised Learning',
        description: 'Laboratório interativo mostrando descida de gradiente em tempo real (Backpropagation). O "Hello World" profundo.',
        tags: ['Backprop', 'Classification', 'Gradients'],
        icon: '🧠',
        color: 'from-purple-400 to-fuchsia-500',
    }
];
