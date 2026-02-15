# Gran-Prix: Advanced Neural Network Framework in Rust

Gran-Prix is a high-performance, modular, and type-safe neural network framework built from the ground up in Rust. It evolves from simple conceptual models into a robust engine for building and training multi-layer perceptrons and beyond.

## ✨ Features
- **Modular Architecture**: Pluggable Layers (`Linear`), Activations (`ReLU`, `Sigmoid`), and Optimizers (`SGD`).
- **Standardized Traits**: Unified `Layer` trait ensures consistent behavior across the entire framework.
- **Robust Training Engine**: Integrated `Sequential` model container with manual-backpropagation support.
- **High Performance**: Powered by `ndarray` for optimized tensor operations and SIMD-ready layouts.
- **Type-Safe & Safe**: Leverages Rust's memory safety and strict typing to prevent runtime architectural errors.

## 🌍 Vision & Future
Gran-Prix aims to be the leading edge-ready neural network framework for the Rust ecosystem. For a deep dive into our goals and "where we are going", see the [Vision & Roadmap](file:///home/ubuntu/.gemini/antigravity/brain/2f43caac-41a8-4d76-bedd-5edc07e23401/vision_and_roadmap.md).

## 🚀 Quick Start (C version - Legacy)
The project began as a C reference, which is now considered legacy.
```bash
# How it started (legacy)
gcc perceptron.c -o perceptron -lm
```

## 🦀 Modern Rust Implementation
The new core is located in `src/`.

### Building
```bash
cargo build --release
```

### Framework Usage Example
```rust
use gran_prix::models::Sequential;
use gran_prix::layers::Linear;
use gran_prix::activations::{ReLU, Sigmoid};

let mut model = Sequential::new();
model.add(Linear::new(6, 12, "input_layer"));
model.add(ReLU);
model.add(Linear::new(12, 1, "output_layer"));
model.add(Sigmoid);

// Forward pass
let output = model.forward(input_tensor);
```

## 🎯 Future Goals
- Implement an **Autograd Engine** for automatic differentiation.
- Support for **Convolutional Layers** (CNNs).
- **CUDA/OpenCL acceleration** via `ndarray-linalg` or custom kernels.
- Comprehensive data loading pipelines for common datasets (MNIST, CIFAR).


