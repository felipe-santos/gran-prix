import {
    Thermometer,
    Bot,
    TrendingUp,
    Zap,
    Navigation,
    Skull,
    PersonStanding,
    Bird,
    CarFront,
    BrainCircuit,
    LucideIcon
} from 'lucide-react';

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
    | 'training'
    | 'turret';

export interface DemoMetadata {
    id: DemoId;
    title: string;
    subtitle: string;
    description: string;
    tags: string[];
    icon: LucideIcon;
    color: string; // Tailwind color class for the glowing accent
}

export const DEMOS: DemoMetadata[] = [
    {
        id: 'oven',
        title: 'Smart Oven IoT',
        subtitle: 'Edge AI Thermodynamics Control',
        description: 'Neural networks acting as advanced PID controllers running at the sensor edge to perfectly bake diverse food types.',
        tags: ['PID', 'Thermodynamics', 'Edge AI'],
        icon: Thermometer,
        color: 'from-orange-500 to-red-500',
    },
    {
        id: 'vacuum',
        title: 'Smart Vacuum',
        subtitle: 'Autonomous Spatial Coverage',
        description: 'Robotic agents learn to navigate, map, and clean a room with dynamic obstacles while maintaining energy efficiency.',
        tags: ['Spatial', 'Pathfinding', 'Energy'],
        icon: Bot,
        color: 'from-blue-400 to-indigo-500',
    },
    {
        id: 'trader',
        title: 'AI Trader',
        subtitle: 'Market Simulation & Prediction',
        description: 'Evolution of trading strategies utilizing technical indicators (RSI, SMA) in a simulated geometric Brownian motion market.',
        tags: ['Finance', 'Time Series', 'Evolution'],
        icon: TrendingUp,
        color: 'from-emerald-400 to-teal-500',
    },
    {
        id: 'smart-grid',
        title: 'Smart Grid',
        subtitle: 'Energy Optimization Routing',
        description: 'Decentralized optimization of solar energy distribution, battery storage, and fluctuating urban demand.',
        tags: ['Logistics', 'Optimization', 'Grid'],
        icon: Zap,
        color: 'from-yellow-400 to-amber-500',
    },
    {
        id: 'drone',
        title: 'Drone Stabilizer',
        subtitle: '6-DOF Attitude Control',
        description: 'Training multi-rotor drones to maintain stability and reach 3D waypoints under unpredictable wind conditions.',
        tags: ['Physics', 'Control Theory', '6-DOF'],
        icon: Navigation,
        color: 'from-cyan-400 to-blue-500',
    },
    {
        id: 'predator-prey',
        title: 'Predator vs Prey',
        subtitle: 'Co-evolutionary Arms Race',
        description: 'Two neural network populations evolving simultaneously: foxes learn to hunt efficiently, rabbits learn to evade.',
        tags: ['Co-evolution', 'Multi-Agent', 'Survival'],
        icon: Skull,
        color: 'from-rose-400 to-red-600',
    },
    {
        id: 'walker',
        title: 'Bipedal Walker',
        subtitle: 'Articulated Physics Locomotion',
        description: 'Gait learning for a bipedal robot traversing irregular terrain using rigid bodies and joint constraints.',
        tags: ['Physics', 'Locomotion', 'Joints'],
        icon: PersonStanding,
        color: 'from-stone-400 to-stone-600',
    },
    {
        id: 'flappy',
        title: 'Flappy Bird RL',
        subtitle: 'Classic Reinforcement Learning',
        description: 'The classic: neural networks learning to navigate varying pipe gaps by calculating vertical and horizontal distances.',
        tags: ['Classic RL', 'Vision', 'Timing'],
        icon: Bird,
        color: 'from-yellow-300 to-green-500',
    },
    {
        id: 'turret',
        title: 'Anti-Drone Tracker',
        subtitle: 'Ballistics & Trajectory Prediction',
        description: 'An AI-controlled turret learns to track evasive drones using pan/tilt motors, adjusting ballistics for dynamic wind vectors.',
        tags: ['Physics', 'Ballistics', 'Tracking'],
        icon: Navigation,
        color: 'from-cyan-500 to-blue-600',
    },
    {
        id: 'evolution',
        title: 'Car Evolution',
        subtitle: 'Genetic Algorithm Basics',
        description: 'Our original engine: cars learning to drive through a track based on distance raycasting and collision detection.',
        tags: ['Raycasting', 'Vehicles', 'Genesis'],
        icon: CarFront,
        color: 'from-red-500 to-rose-600',
    },
    {
        id: 'training',
        title: 'Backprop Classifier',
        subtitle: 'Core Supervised Learning',
        description: 'Interactive laboratory visualizing gradient descent in real-time (Backpropagation). The deep learning "Hello World".',
        tags: ['Backprop', 'Classification', 'Gradients'],
        icon: BrainCircuit,
        color: 'from-purple-400 to-fuchsia-500',
    }
];
