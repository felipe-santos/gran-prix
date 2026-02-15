use gran_prix::layers::linear::Linear;
use gran_prix::{Layer, Tensor};
use ndarray::array;

#[test]
fn test_linear_layer_robustness() {
    let mut layer = Linear::new(3, 2, "test_layer");
    
    // 1. Check name
    assert_eq!(layer.name(), "test_layer");
    
    // 2. Forward pass precision
    let input = array![[1.0, 2.0, 3.0]];
    let out = layer.forward(&input);
    assert_eq!(out.shape(), &[1, 2]);
    
    // 3. Backward pass alignment
    let grad_out = array![[0.1, 0.2]];
    let grad_in = layer.backward(&input, &grad_out);
    assert_eq!(grad_in.shape(), &[1, 3]);
}

#[test]
fn test_sequential_stacking() {
    // This tests if our Layer trait allows composition
    let l1 = Linear::new(10, 5, "l1");
    let l2 = Linear::new(5, 1, "l2");
    
    let x = Tensor::zeros((1, 10));
    let h = l1.forward(&x);
    let out = l2.forward(&h);
    
    assert_eq!(out.shape(), &[1, 1]);
}
