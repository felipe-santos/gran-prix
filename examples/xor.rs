use gran_prix::models::Sequential;
use gran_prix::layers::Linear;
use gran_prix::activations::Sigmoid;
use gran_prix::loss::{Loss, MSE};
use gran_prix::Tensor;
use ndarray::array;

fn main() {
    // 1. Prepare Data (XOR)
    let inputs: Tensor = array![
        [0.0, 0.0],
        [0.0, 1.0],
        [1.0, 0.0],
        [1.0, 1.0]
    ];
    let targets: Tensor = array![
        [0.0],
        [1.0],
        [1.0],
        [0.0]
    ];

    // 2. Define Architecture
    let mut model = Sequential::new();
    model.add(Linear::new(2, 4, "hidden"));
    model.add(Sigmoid);
    model.add(Linear::new(4, 1, "output"));
    model.add(Sigmoid);

    let loss_fn = MSE;
    let learning_rate = 0.5;

    // 3. Training Loop
    println!("Starting XOR training...");
    for epoch in 0..50001 {
        // Forward pass
        let output = model.forward(inputs.clone());
        let loss = loss_fn.calculate(&output, &targets);
        
        // Backward pass
        let grad_output = loss_fn.gradient(&output, &targets);
        model.backward(grad_output);

        // Update parameters
        model.update(learning_rate);
        
        if epoch % 1000 == 0 {
            println!("Epoch {}: Loss = {:.6}", epoch, loss);
        }
    }

    // 4. Final Validation
    let final_output = model.forward(inputs.clone());
    println!("\nFinal Results:");
    for i in 0..4 {
        println!("In: {:?} | Expected: {:?} | Predicted: {:.4}", 
            inputs.row(i), targets.row(i), final_output[[i, 0]]);
    }
}
