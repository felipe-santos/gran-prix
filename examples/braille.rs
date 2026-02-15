use gran_prix::models::Sequential;
use gran_prix::layers::Linear;
use gran_prix::activations::Sigmoid;
use gran_prix::loss::{Loss, MSE};
use gran_prix::Tensor;
use ndarray::array;

fn main() {
    // 1. Braille Dataset (subset extracted from legacy C code)
    // 6 inputs (dots) -> 1 output (char index)
    let inputs: Tensor = array![
        [0.0, 0.0, 0.0, 0.0, 0.0, 0.0], // (space) -> 0
        [0.0, 1.0, 1.0, 1.0, 0.0, 1.0], // the -> 29
        [0.0, 0.0, 0.0, 0.0, 1.0, 0.0], // (contraction) -> 2
        [1.0, 0.0, 0.0, 0.0, 0.0, 0.0], // a -> 32
        [1.0, 1.0, 0.0, 0.0, 0.0, 0.0]  // b -> 48
    ];
    
    // Normalizing targets to [0, 1] for Sigmoid output
    let targets: Tensor = array![
        [0.0],
        [0.29],
        [0.02],
        [0.32],
        [0.48]
    ];

    // 2. Define Architecture
    let mut model = Sequential::new();
    model.add(Linear::new(6, 12, "hidden"));
    model.add(Sigmoid);
    model.add(Linear::new(12, 1, "output"));
    model.add(Sigmoid);

    let loss_fn = MSE;
    let learning_rate = 0.3;

    // 3. Training Loop
    println!("Starting Braille challenge training...");
    for epoch in 0..20001 {
        let output = model.forward(inputs.clone());
        let loss = loss_fn.calculate(&output, &targets);
        
        let grad_output = loss_fn.gradient(&output, &targets);
        model.backward(grad_output);
        model.update(learning_rate);
        
        if epoch % 5000 == 0 {
            println!("Epoch {}: Loss = {:.6}", epoch, loss);
        }
    }

    // 4. Verification
    let final_output = model.forward(inputs.clone());
    println!("\nFinal Results (Predicted vs Target):");
    for i in 0..5 {
        println!("Pattern {:?} | Expected: {:.2} | Predicted: {:.4}", 
            i, targets[[i, 0]], final_output[[i, 0]]);
    }
}
