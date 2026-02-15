use gran_prix::models::Sequential;
use gran_prix::layers::Linear;
use gran_prix::activations::{ReLU, Sigmoid};
use gran_prix::loss::{Loss, MSE};
use gran_prix::Tensor;
use ndarray::array;

fn main() {
    println!("⚙️ Gran-Prix System Optimization Demo: Adaptive Cache Tuner");
    
    // 1. Data: [CPU Load (0-1), Requests per second (normalized)] -> [Optimal Cache Size (0-1)]
    // Pattern: High load + High requests -> Decrease cache (save memory)
    //          Low load + High requests -> Increase cache (improve latency)
    let inputs: Tensor = array![
        [0.1, 0.9], // Low Load, Many Req -> Large Cache (0.9)
        [0.9, 0.9], // High Load, Many Req -> Small Cache (0.2)
        [0.5, 0.5], // Medium Load, Medium Req -> Medium Cache (0.5)
        [0.8, 0.1]  // High Load, Few Req -> Medium/Small Cache (0.3)
    ];
    let targets: Tensor = array![
        [0.9],
        [0.2],
        [0.5],
        [0.3]
    ];

    // 2. Define Optimizer Brain
    let mut tuner = Sequential::new();
    tuner.add(Linear::new(2, 6, "input"));
    tuner.add(ReLU);
    tuner.add(Linear::new(6, 1, "output"));
    tuner.add(Sigmoid);

    let loss_fn = MSE;
    let learning_rate = 0.25;

    // 3. Training the Optimizer
    println!("Tuning the model to your system load patterns...");
    for epoch in 0..10001 {
        let prediction = tuner.forward(inputs.clone());
        let loss = loss_fn.calculate(&prediction, &targets);
        
        let grad = loss_fn.gradient(&prediction, &targets);
        tuner.backward(grad);
        tuner.update(learning_rate);

        if epoch % 2000 == 0 {
            println!("Epoch {}: Tuning Error = {:.6}", epoch, loss);
        }
    }

    // 4. Test on a novel system state
    let sudden_load_spike: Tensor = array![[0.95, 0.8]]; // 95% CPU, 80% RPS
    let cache_size_rec = tuner.forward(sudden_load_spike);
    
    println!("\nSystem State [CPU: 95%, RPS: 80%]");
    println!("Recommendation: Set Cache Size to {:.1}% of max", cache_size_rec[[0, 0]] * 100.0);
    
    if cache_size_rec[[0, 0]] < 0.3 {
        println!("Status: ✅ Correct. Model intelligently reduced cache to protect system stability.");
    } else {
        println!("Status: ⚠️ Warning. Model recommend too much cache for high CPU load.");
    }
}
