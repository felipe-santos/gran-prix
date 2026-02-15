use gran_prix::models::Sequential;
use gran_prix::layers::Linear;
use gran_prix::activations::Sigmoid;
use gran_prix::Tensor;
use ndarray::array;
use std::fs::File;
use std::io::{Write, Read};

fn main() -> anyhow::Result<()> {
    // 1. Create and Configure a Model
    let mut model = Sequential::new();
    model.add(Linear::new(2, 4, "hidden"));
    model.add(Sigmoid);
    model.add(Linear::new(4, 1, "output"));
    model.add(Sigmoid);

    let input: Tensor = array![[0.5, 0.8]];
    let original_output = model.forward(input.clone());
    println!("Original prediction: {:.4}", original_output[[0, 0]]);

    // 2. Save the Model to Disk (Edge scenario: Pre-trained model deployment)
    let json = serde_json::to_string_pretty(&model)?;
    let mut file = File::create("model.json")?;
    file.write_all(json.as_bytes())?;
    println!("Model saved to model.json");

    // 3. Load the Model back (Inference scenario)
    let mut file = File::open("model.json")?;
    let mut contents = String::new();
    file.read_to_string(&mut contents)?;
    
    let mut loaded_model: Sequential = serde_json::from_str(&contents)?;
    println!("Model loaded successfully");

    // 4. Verify identical behavior
    let loaded_output = loaded_model.forward(input.clone());
    println!("Loaded prediction:   {:.4}", loaded_output[[0, 0]]);

    if (original_output[[0, 0]] - loaded_output[[0, 0]]).abs() < 1e-6 {
        println!("\n✅ Success! Loaded model behavior matches the original.");
    } else {
        println!("\n❌ Error: Model behavior mismatch after loading.");
    }

    Ok(())
}
