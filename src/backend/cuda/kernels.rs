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

extern "C" __global__ void gp_mul_backward(
    float* grad_a,
    float* grad_b,
    const float* a,
    const float* b,
    const float* grad_output,
    int n
) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        grad_a[i] = grad_output[i] * b[i];
        grad_b[i] = grad_output[i] * a[i];
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

extern "C" __global__ void gp_max_pool2d(
    float* out,
    const float* input,
    int n,
    int c,
    int h,
    int w,
    int oh,
    int ow,
    int kernel_size,
    int stride
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total = n * c * oh * ow;
    if (idx >= total) {
        return;
    }

    int wi = idx % ow;
    int hi = (idx / ow) % oh;
    int ci = (idx / (oh * ow)) % c;
    int ni = idx / (c * oh * ow);

    float max_val = -3.402823466e+38f;
    for (int kh = 0; kh < kernel_size; ++kh) {
        for (int kw = 0; kw < kernel_size; ++kw) {
            int cur_h = hi * stride + kh;
            int cur_w = wi * stride + kw;
            float value = input[ni * (c * h * w) + ci * (h * w) + cur_h * w + cur_w];
            if (value > max_val) {
                max_val = value;
            }
        }
    }

    out[idx] = max_val;
}

extern "C" __global__ void gp_max_pool2d_backward(
    float* grad_input,
    const float* input,
    const float* grad_output,
    int n,
    int c,
    int h,
    int w,
    int oh,
    int ow,
    int kernel_size,
    int stride
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total = n * c * oh * ow;
    if (idx >= total) {
        return;
    }

    int wi = idx % ow;
    int hi = (idx / ow) % oh;
    int ci = (idx / (oh * ow)) % c;
    int ni = idx / (c * oh * ow);

    float max_val = -3.402823466e+38f;
    int max_h = 0;
    int max_w = 0;

    for (int kh = 0; kh < kernel_size; ++kh) {
        for (int kw = 0; kw < kernel_size; ++kw) {
            int cur_h = hi * stride + kh;
            int cur_w = wi * stride + kw;
            float value = input[ni * (c * h * w) + ci * (h * w) + cur_h * w + cur_w];
            if (value > max_val) {
                max_val = value;
                max_h = cur_h;
                max_w = cur_w;
            }
        }
    }

    atomicAdd(
        &grad_input[ni * (c * h * w) + ci * (h * w) + max_h * w + max_w],
        grad_output[idx]
    );
}

extern "C" __global__ void gp_conv2d(
    float* out,
    const float* input,
    const float* weight,
    int n,
    int ci,
    int h,
    int w,
    int co,
    int kh,
    int kw,
    int oh,
    int ow,
    int stride,
    int padding
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total = n * co * oh * ow;
    if (idx >= total) {
        return;
    }

    int wi = idx % ow;
    int hi = (idx / ow) % oh;
    int coi = (idx / (oh * ow)) % co;
    int ni = idx / (co * oh * ow);

    float sum = 0.0f;
    for (int cii = 0; cii < ci; ++cii) {
        for (int khi = 0; khi < kh; ++khi) {
            for (int kwi = 0; kwi < kw; ++kwi) {
                int in_h = hi * stride + khi - padding;
                int in_w = wi * stride + kwi - padding;
                if (in_h >= 0 && in_h < h && in_w >= 0 && in_w < w) {
                    sum += input[ni * (ci * h * w) + cii * (h * w) + in_h * w + in_w] *
                           weight[coi * (ci * kh * kw) + cii * (kh * kw) + khi * kw + kwi];
                }
            }
        }
    }

    out[idx] = sum;
}

extern "C" __global__ void gp_conv2d_grad_input(
    float* grad_input,
    const float* weight,
    const float* grad_output,
    int n,
    int ci,
    int h,
    int w,
    int co,
    int kh,
    int kw,
    int oh,
    int ow,
    int stride,
    int padding
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total = n * ci * h * w;
    if (idx >= total) {
        return;
    }

    int wi = idx % w;
    int hi = (idx / w) % h;
    int cii = (idx / (h * w)) % ci;
    int ni = idx / (ci * h * w);

    float sum = 0.0f;
    for (int coi = 0; coi < co; ++coi) {
        for (int khi = 0; khi < kh; ++khi) {
            for (int kwi = 0; kwi < kw; ++kwi) {
                int out_h_unstrided = hi + padding - khi;
                int out_w_unstrided = wi + padding - kwi;
                if (out_h_unstrided >= 0 && out_w_unstrided >= 0 &&
                    out_h_unstrided % stride == 0 && out_w_unstrided % stride == 0) {
                    int out_h = out_h_unstrided / stride;
                    int out_w = out_w_unstrided / stride;
                    if (out_h >= 0 && out_h < oh && out_w >= 0 && out_w < ow) {
                        sum += grad_output[ni * (co * oh * ow) + coi * (oh * ow) + out_h * ow + out_w] *
                               weight[coi * (ci * kh * kw) + cii * (kh * kw) + khi * kw + kwi];
                    }
                }
            }
        }
    }

    grad_input[idx] = sum;
}

extern "C" __global__ void gp_conv2d_grad_weight(
    float* grad_weight,
    const float* input,
    const float* grad_output,
    int n,
    int ci,
    int h,
    int w,
    int co,
    int kh,
    int kw,
    int oh,
    int ow,
    int stride,
    int padding
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total = co * ci * kh * kw;
    if (idx >= total) {
        return;
    }

    int kwi = idx % kw;
    int khi = (idx / kw) % kh;
    int cii = (idx / (kh * kw)) % ci;
    int coi = idx / (ci * kh * kw);

    float sum = 0.0f;
    for (int ni = 0; ni < n; ++ni) {
        for (int out_h = 0; out_h < oh; ++out_h) {
            for (int out_w = 0; out_w < ow; ++out_w) {
                int in_h = out_h * stride + khi - padding;
                int in_w = out_w * stride + kwi - padding;
                if (in_h >= 0 && in_h < h && in_w >= 0 && in_w < w) {
                    sum += grad_output[ni * (co * oh * ow) + coi * (oh * ow) + out_h * ow + out_w] *
                           input[ni * (ci * h * w) + cii * (h * w) + in_h * w + in_w];
                }
            }
        }
    }

    grad_weight[idx] = sum;
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
