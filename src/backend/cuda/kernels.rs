pub const CUDA_KERNELS: &str = r#"
extern "C" __global__ void gp_add(float* out, const float* a, const float* b, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        out[i] = a[i] + b[i];
    }
}

extern "C" __global__ void gp_mul(float* out, const float* a, const float* b, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        out[i] = a[i] * b[i];
    }
}

extern "C" __global__ void gp_relu(float* out, const float* x, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        float v = x[i];
        out[i] = v > 0.0f ? v : 0.0f;
    }
}

extern "C" __global__ void gp_sigmoid(float* out, const float* x, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        out[i] = 1.0f / (1.0f + expf(-x[i]));
    }
}

extern "C" __global__ void gp_tanh(float* out, const float* x, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        out[i] = tanhf(x[i]);
    }
}

extern "C" __global__ void gp_relu_backward(float* out, const float* input, const float* grad_output, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        out[i] = input[i] > 0.0f ? grad_output[i] : 0.0f;
    }
}

extern "C" __global__ void gp_sigmoid_backward(float* out, const float* output, const float* grad_output, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        float s = output[i];
        out[i] = grad_output[i] * s * (1.0f - s);
    }
}

extern "C" __global__ void gp_tanh_backward(float* out, const float* output, const float* grad_output, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        float y = output[i];
        out[i] = grad_output[i] * (1.0f - y * y);
    }
}

extern "C" __global__ void gp_add_relu(float* out, const float* a, const float* b, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        float v = a[i] + b[i];
        out[i] = v > 0.0f ? v : 0.0f;
    }
}

extern "C" __global__ void gp_sgd_update(float* out, const float* param, const float* grad, float lr, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        out[i] = param[i] - lr * grad[i];
    }
}

extern "C" __global__ void gp_reduce_sum(
    float* out,
    const float* input,
    const int* input_shape,
    const int* output_shape,
    const int* axes_mask,
    int input_len,
    int output_len,
    int rank,
    int output_rank,
    int keep_dims
) {
    int out_idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (out_idx >= output_len) {
        return;
    }

    int out_coords[8];
    int tmp_out = out_idx;
    for (int d = output_rank - 1; d >= 0; --d) {
        int size = output_shape[d];
        out_coords[d] = tmp_out % size;
        tmp_out /= size;
    }

    float sum = 0.0f;
    for (int in_idx = 0; in_idx < input_len; ++in_idx) {
        int tmp_in = in_idx;
        int out_d = output_rank - 1;
        int matches = 1;

        for (int d = rank - 1; d >= 0; --d) {
            int coord = tmp_in % input_shape[d];
            tmp_in /= input_shape[d];

            if (axes_mask[d]) {
                if (keep_dims) {
                    if (out_coords[d] != 0) {
                        matches = 0;
                    }
                }
            } else {
                int compare_d = keep_dims ? d : out_d;
                if (compare_d < 0 || coord != out_coords[compare_d]) {
                    matches = 0;
                }
                if (!keep_dims) {
                    out_d -= 1;
                }
            }
        }

        if (matches) {
            sum += input[in_idx];
        }
    }

    out[out_idx] = sum;
}

extern "C" __global__ void gp_matmul(
    float* out,
    const float* a,
    const float* b,
    int m,
    int n,
    int k,
    int a_cols,
    int b_cols,
    int trans_a,
    int trans_b
) {
    int row = blockIdx.y * blockDim.y + threadIdx.y;
    int col = blockIdx.x * blockDim.x + threadIdx.x;

    if (row < m && col < n) {
        float sum = 0.0f;
        for (int i = 0; i < k; ++i) {
            float av = trans_a ? a[i * a_cols + row] : a[row * a_cols + i];
            float bv = trans_b ? b[col * b_cols + i] : b[i * b_cols + col];
            sum += av * bv;
        }
        out[row * n + col] = sum;
    }
}
"#;
