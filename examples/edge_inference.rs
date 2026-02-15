use gran_prix::models::Sequential;
use gran_prix::layers::Linear;
use gran_prix::activations::Sigmoid;
use ndarray::array;

fn main() -> anyhow::Result<()> {
    // 1. Create and Configure a Model
    let mut model = Sequential::new();
    model.add(Linear::new(2, 4, "hidden"));
    model.add(Sigmoid);
    model.add(Linear::new(4, 1, "output"));
    // 1. Initial prediction
    let input = array![[0.5, 0.5]].into_dyn();
    let original_out = model.forward(input.clone());
    println!("Original prediction: {:.4}", original_out[[0, 0]]);

    // 2. Save model
    let json = serde_json::to_string_pretty(&model)?;
    std::fs::write("model.json", json)?;
    println!("Model saved to model.json");

    // 3. Load model
    let loaded_json = std::fs::read_to_string("model.json")?;
    let mut loaded_model: Sequential = serde_json::from_str(&loaded_json)?;
    println!("Model loaded successfully");

    // 4. Verify Loaded prediction
    let loaded_out = loaded_model.forward(input);
    println!("Loaded prediction:   {:.4}", loaded_out[[0, 0]]);

    if (original_out[[0, 0]] - loaded_out[[0, 0]]).abs() < 1e-6 {
        println!("\n✅ Success! Loaded model behavior matches the original.");
    } else {
        println!("\n❌ Error: Model behavior mismatch after loading.");
    }

    Ok(())
}
