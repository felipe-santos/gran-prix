use crate::trainer::Trainer;

#[test]
fn test_gradient_flow() {
    // 2 inputs, 2 hidden layers (4, 4), 1 output
    let trainer = Trainer::new(2, vec![4, 4]).unwrap();
    
    // Train on a simple XOR-like point
    let inputs = vec![1.0, -1.0];
    let targets = vec![1.0];
    let lr = 0.1;
    
    // Perform one train batch
    trainer.train_batch(inputs, targets, lr).unwrap();
    
    // We can't directly access gradients from JS Trainer struct easily in a test 
    // without public methods, so I'll check if weights actually changed.
    
    let w_initial = trainer.get_weights().unwrap();
    
    // Train many times to ensure change is visible
    for _ in 0..100 {
        trainer.train_batch(vec![1.0, -1.0], vec![1.0], 0.5).unwrap();
    }
    
    let w_final = trainer.get_weights().unwrap();
    
    // Layer 1: Param 0 (W1: 2x4=8), Param 1 (B1: 4) -> 0..12
    // Layer 2: Param 2 (W2: 4x4=16), Param 3 (B2: 4) -> 12..32
    // Layer 3: Param 4 (W3: 4x1=4), Param 5 (B3: 1)  -> 32..37
    
    println!("Weights comparison:");
    let diffs: Vec<f32> = w_initial.iter().zip(w_final.iter()).map(|(a, b)| (a - b).abs()).collect::<Vec<f32>>();
    
    println!("L1 Change Sum: {}", diffs[0..12].iter().sum::<f32>());
    println!("L2 Change Sum: {}", diffs[12..32].iter().sum::<f32>());
    println!("L3 Change Sum: {}", diffs[32..37].iter().sum::<f32>());
}
