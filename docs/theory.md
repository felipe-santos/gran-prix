# Gran-Prix: The Theory Behind the Engine

This document explains the mathematical foundations of Gran-Prix, targeting the **Education** niche.

## 1. Linear Layer (Dense)
A linear layer performs a simple matrix multiplication followed by an addition of a bias vector.

**Forward Pass:**
$$Y = X \cdot W + B$$
Where:
- $X$: Input tensor (Batch size x Input dim)
- $W$: Weight matrix (Input dim x Output dim)
- $B$: Bias vector (1 x Output dim)

**Backward Pass (Gradients):**
To train the network, we need the gradients of the loss $L$ with respect to inputs and parameters.
- $\frac{\partial L}{\partial W} = X^T \cdot \frac{\partial L}{\partial Y}$
- $\frac{\partial L}{\partial B} = \sum_{row} \frac{\partial L}{\partial Y}$
- $\frac{\partial L}{\partial X} = \frac{\partial L}{\partial Y} \cdot W^T$ (passed to the previous layer)

## 2. Activations
Activations introduce non-linearity, allowing the model to learn complex patterns.

### Sigmoid
- **Function:** $\sigma(z) = \frac{1}{1 + e^{-z}}$
- **Derivative:** $\sigma'(z) = \sigma(z) \cdot (1 - \sigma(z))$

### ReLU (Rectified Linear Unit)
- **Function:** $f(z) = \max(0, z)$
- **Derivative:** $f'(z) = 1$ if $z > 0$, else $0$.

## 3. Loss Function (MSE)
Mean Squared Error measures the average squared difference between predictions and targets.
- **Formula:** $MSE = \frac{1}{N} \sum (Y_{pred} - Y_{target})^2$
- **Gradient:** $\frac{\partial MSE}{\partial Y_{pred}} = \frac{2}{N} (Y_{pred} - Y_{target})$

## 4. Optimization (SGD)
Stochastic Gradient Descent updates weights by moving them in the opposite direction of the gradient.
- $W_{new} = W_{old} - \eta \cdot \frac{\partial L}{\partial W}$
Where $\eta$ is the learning rate.
