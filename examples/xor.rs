use gran_prix::models::Sequential;
use gran_prix::layers::Linear;
use gran_prix::activations::{ReLU, Sigmoid};
use gran_prix::loss::{Loss, MSE};
use gran_prix::Tensor;
use ndarray::array;

fn main() {
    println!("✨ Gran-Prix XOR Challenge: MLP with Sequential API");

    // 1. Prepare Data
    let inputs: Tensor = array![
        [0.0, 0.0],
        [0.0, 1.0],
        [1.0, 0.0],
        [1.0, 1.0]
    ].into_dyn().into();
    
    let targets: Tensor = array![
        [0.0],
        [1.0],
        [1.0],
        [0.0]
    ].into_dyn().into();

    // 2. Define Architecture
    let mut model = Sequential::new();
    model.add(Linear::new(2, 4, "hidden"));
    model.add(ReLU);
    model.add(Linear::new(4, 1, "output"));
    model.add(Sigmoid);

    let loss_fn = MSE;
    let learning_rate = 0.5;

    // 3. Training Loop
    println!("Starting training...");
    for epoch in 0..10001 {
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
            inputs.view().slice(ndarray::s![i, ..]), targets.view().slice(ndarray::s![i, ..]), final_output.view()[[i, 0]]);
    }
}
