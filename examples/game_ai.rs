use gran_prix::models::Sequential;
use gran_prix::layers::Linear;
use gran_prix::activations::{ReLU, Sigmoid};
use gran_prix::loss::{Loss, MSE};
use gran_prix::Tensor;
use ndarray::array;

fn main() {
    println!("🎮 Gran-Prix Game AI Demo: Learning to Avoid Obstacles");
    
    // 1. Data: [Distance to Obstacle, Velocity] -> [Turn Speed (0=Sharp Left, 0.5=Straight, 1.0=Sharp Right)]
    // Scenario: Obstacle is always on the right if distance is small.
    let inputs: Tensor = array![
        [1.0, 1.0], // Safe, far away -> Straight
        [0.2, 0.8], // Danger, close -> Turn Left (0.0)
        [0.9, 0.2], // Safe, slow -> Straight
        [0.1, 1.0]  // Critical Danger -> Turn Left (0.0)
    ];
    let targets: Tensor = array![
        [0.5],
        [0.0],
        [0.5],
        [0.0]
    ];

    // 2. Define NPC Brain
    let mut npc_brain = Sequential::new();
    npc_brain.add(Linear::new(2, 8, "input"));
    npc_brain.add(ReLU);
    npc_brain.add(Linear::new(8, 1, "output"));
    npc_brain.add(Sigmoid);

    let loss_fn = MSE;
    let learning_rate = 0.2;

    // 3. Simulated "Real-time" Training (mimicking learning over game frames)
    for frame in 0..5001 {
        let prediction = npc_brain.forward(inputs.clone());
        let loss = loss_fn.calculate(&prediction, &targets);
        
        let gradient = loss_fn.gradient(&prediction, &targets);
        npc_brain.backward(gradient);
        npc_brain.update(learning_rate);

        if frame % 1000 == 0 {
            println!("Frame {}: Learning Error = {:.6}", frame, loss);
        }
    }

    // 4. Test NPC with a new situation
    let new_danger: Tensor = array![[0.15, 0.9]]; // Very close, high velocity
    let action = npc_brain.forward(new_danger);
    
    println!("\nNPC Decision for [Distance: 0.15, Velocity: 0.9]: {:.4}", action[[0, 0]]);
    if action[[0, 0]] < 0.2 {
        println!("Result: 🏃 Safe! NPC successfully learned to swerve left to avoid collision.");
    } else {
        println!("Result: 💥 Crash! NPC needs more training.");
    }
}
