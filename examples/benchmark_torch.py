import time
import torch

def benchmark():
    size = 500
    iterations = 50
    
    # Check for CUDA
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Benchmarking on: {device}")

    # Initialize Tensors
    a = torch.ones(size, size, device=device)
    b = torch.ones(size, size, device=device)

    # Warmup
    torch.matmul(a, b)
    if device.type == 'cuda':
        torch.cuda.synchronize()

    start_time = time.time()
    
    for _ in range(iterations):
        res = torch.matmul(a, b)
        
    if device.type == 'cuda':
        torch.cuda.synchronize()
        
    end_time = time.time()
    duration = end_time - start_time
    
    gflops = (2.0 * size**3 * iterations) / (duration * 1e9)
    print(f"Time taken: {duration:.4f}s")
    print(f"GFLOPS: {gflops:.2f}")

if __name__ == "__main__":
    benchmark()
