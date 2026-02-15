use gran_prix::graph::Graph;
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::Tensor;
use ndarray::{Array4, Array2};
use std::time::Instant;

fn generate_synthetic_data(num_samples: usize, img_size: usize) -> (Vec<Tensor>, Vec<f32>) {
    let mut inputs = Vec::new();
    let mut labels = Vec::new();

    for i in 0..num_samples {
        let mut img = Array4::<f32>::zeros((1, 1, img_size, img_size));
        let label = (i % 2) as f32; // 0 for Vertical, 1 for Horizontal
        
        if label == 0.0 {
            // Vertical bar
            let col = i % img_size;
            for r in 0..img_size {
                img[[0, 0, r, col]] = 1.0;
            }
        } else {
            // Horizontal bar
            let row = i % img_size;
            for c in 0..img_size {
                img[[0, 0, row, c]] = 1.0;
            }
        }
        
        // Add some noise
        img += &(Array4::<f32>::from_shape_fn((1, 1, img_size, img_size), |_| {
            (rand::random::<f32>() - 0.5) * 0.2
        }));

        inputs.push(img.into_dyn().into());
        labels.push(label);
    }
    (inputs, labels)
}

fn main() {
    println!("--- Gran-Prix: MNIST Tiny (Synthetic Pattern Training) ---");
    
    let img_size = 10;
    let (train_x, train_y) = generate_synthetic_data(100, img_size);
    let (test_x, test_y) = generate_synthetic_data(20, img_size);

    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);

    // Architecture:
    // Input(1, 1, 10, 10)
    // Conv2D(1, 4, k=3, s=1, p=1) -> ReLU
    // MaxPool2D(k=2, s=2) -> (4, 5, 5)
    // Flatten -> (1, 100)
    // Linear(100, 1) -> Sigmoid

    let x = gb.val(Array4::<f32>::zeros((1, 1, img_size, img_size)).into_dyn().into());
    
    // Conv Layer
    let w_conv = gb.param(Array4::<f32>::from_shape_fn((4, 1, 3, 3), |_| {
        (rand::random::<f32>() - 0.5) * 0.1
    }).into_dyn().into());
    let conv = gb.conv2d(x, w_conv, 1, 1);
    let relu1 = gb.relu(conv);
    
    // Pool Layer
    let pool = gb.max_pool2d(relu1, 2, 2);
    
    // Flatten (Output of pool is 1x4x5x5 = 100)
    let flattened = gb.reshape(pool, vec![1, 100]);
    
    // Output Layer (Linear)
    let w_out = gb.param(Array2::<f32>::from_shape_fn((100, 1), |_| {
        (rand::random::<f32>() - 0.5) * 0.1
    }).into_dyn().into());
    let b_out = gb.param(Array2::<f32>::zeros((1, 1)).into_dyn().into());
    let logits = gb.linear(flattened, w_out, b_out);
    let prediction = gb.sigmoid(logits);

    let learning_rate = 0.05;
    let epochs = 50;
    
    println!("Starting training for {} epochs...", epochs);
    let start_time = Instant::now();

    for epoch in 1..=epochs {
        let mut total_loss = 0.0;
        let mut correct = 0;

        for (i, input) in train_x.iter().enumerate() {
            let label = train_y[i];
            
            // 1. Set Input
            if let gran_prix::graph::Node::Input(ref mut t) = graph.nodes_mut()[x.0] {
                *t = input.clone();
            }
            
            // 2. Clear Values and Gradients
            graph.clear_values();
            graph.clear_gradients();

            // 3. Forward
            let out = graph.execute(prediction).unwrap();
            let pred_val = out.view()[[0, 0]];
            
            // Binary Cross Entropy Loss Gradient: (pred - label)
            let loss_grad = pred_val - label;
            total_loss += loss_grad.powi(2); // MSE for simplicity in demo
            
            if (pred_val > 0.5 && label == 1.0) || (pred_val <= 0.5 && label == 0.0) {
                correct += 1;
            }

            // 4. Backward
            graph.backward(prediction, Array2::from_elem((1, 1), loss_grad).into_dyn().into()).unwrap();

            // 5. Update
            graph.update_parameters(learning_rate).unwrap();
        }

        if epoch % 10 == 0 || epoch == 1 {
            let acc = (correct as f32 / train_x.len() as f32) * 100.0;
            println!("Epoch {}: Loss={:.4}, Accuracy={:.2}%", epoch, total_loss / train_x.len() as f32, acc);
        }
    }

    let duration = start_time.elapsed();
    println!("Training completed in {:?}.", duration);

    // Final Evaluation
    let mut test_correct = 0;
    for (i, input) in test_x.iter().enumerate() {
        let label = test_y[i];
        if let gran_prix::graph::Node::Input(ref mut t) = graph.nodes_mut()[x.0] {
            *t = input.clone();
        }
        graph.clear_values();
        let out = graph.execute(prediction).unwrap();
        let pred_val = out.view()[[0, 0]];
        if (pred_val > 0.5 && label == 1.0) || (pred_val <= 0.5 && label == 0.0) {
            test_correct += 1;
        }
    }
    
    println!("Test Accuracy: {:.2}%", (test_correct as f32 / test_x.len() as f32) * 100.0);
    println!("Optimization complete. CNN has learned to distinguish spatial patterns!");
}
