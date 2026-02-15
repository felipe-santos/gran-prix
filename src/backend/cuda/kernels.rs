pub const ELEMENTWISE_KERNELS: &str = r#"
extern "C" __global__ void relu_kernel(float* out, const float* in, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        out[i] = fmaxf(0.0f, in[i]);
    }
}

extern "C" __global__ void sigmoid_kernel(float* out, const float* in, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        out[i] = 1.0f / (1.0f + expf(-in[i]));
    }
}

extern "C" __global__ void add_kernel(float* out, const float* a, const float* b, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        out[i] = a[i] + b[i];
extern "C" __global__ void conv2d_kernel(
    float* out, const float* in, const float* weight,
    int n, int ci, int h, int w,
    int co, int kh, int kw,
    int oh, int ow,
    int stride, int padding
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total = n * co * oh * ow;
    if (idx < total) {
        int ni = idx / (co * oh * ow);
        int coi = (idx / (oh * ow)) % co;
        int hi = (idx / ow) % oh;
        int wi = idx % ow;

        float sum = 0.0f;
        for (int cii = 0; cii < ci; ++cii) {
            for (int k_hi = 0; k_hi < kh; ++k_hi) {
                for (int k_wi = 0; k_wi < kw; ++k_wi) {
                    int in_h = hi * stride + k_hi - padding;
                    int in_w = wi * stride + k_wi - padding;
                    if (in_h >= 0 && in_h < h && in_w >= 0 && in_w < w) {
                        sum += in[ni * (ci * h * w) + cii * (h * w) + in_h * w + in_w] *
                               weight[coi * (ci * kh * kw) + cii * (kh * kw) + k_hi * kw + k_wi];
                    }
                }
            }
        }
        out[idx] = sum;
    }
}

extern "C" __global__ void max_pool2d_kernel(
    float* out, const float* in,
    int n, int c, int h, int w,
    int oh, int ow,
    int kh, int kw,
    int stride
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total = n * c * oh * ow;
    if (idx < total) {
        int ni = idx / (c * oh * ow);
        int ci = (idx / (oh * ow)) % c;
        int hi = (idx / ow) % oh;
        int wi = idx % ow;

        float max_val = -1e38f;
        for (int kh_i = 0; kh_i < kh; ++kh_i) {
            for (int kw_i = 0; kw_i < kw; ++kw_i) {
                int in_h = hi * stride + kh_i;
                int in_w = wi * stride + kw_i;
                if (in_h < h && in_w < w) {
                    float val = in[ni * (c * h * w) + ci * (h * w) + in_h * w + in_w];
                    if (val > max_val) max_val = val;
                }
            }
        }
        out[idx] = max_val;
extern "C" __global__ void relu_backward_kernel(float* grad_in, const float* in, const float* grad_out, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        grad_in[i] = (in[i] > 0.0f) ? grad_out[i] : 0.0f;
    }
}

extern "C" __global__ void sigmoid_backward_kernel(float* grad_in, const float* out, const float* grad_out, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        float s = out[i];
        grad_in[i] = grad_out[i] * s * (1.0f - s);
    }
}

extern "C" __global__ void conv2d_grad_input_kernel(
    float* grad_in, const float* grad_out, const float* weight,
    int n, int ci, int h, int w,
    int co, int kh, int kw,
    int oh, int ow,
    int stride, int padding
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total = n * ci * h * w;
    if (idx < total) {
        int ni = idx / (ci * h * w);
        int cii = (idx / (h * w)) % ci;
        int hi = (idx / w) % h;
        int wi = idx % w;

        float sum = 0.0f;
        for (int coi = 0; coi < co; ++coi) {
            for (int k_hi = 0; k_hi < kh; ++k_hi) {
                for (int k_wi = 0; k_wi < kw; ++k_wi) {
                    int out_h = (hi + padding - k_hi);
                    int out_w = (wi + padding - k_wi);
                    
                    if (out_h >= 0 && out_h % stride == 0 && out_w >= 0 && out_w % stride == 0) {
                        int oh_idx = out_h / stride;
                        int ow_idx = out_w / stride;
                        if (oh_idx >= 0 && oh_idx < oh && ow_idx >= 0 && ow_idx < ow) {
                            sum += grad_out[ni * (co * oh * ow) + coi * (oh * ow) + oh_idx * ow + ow_idx] *
                                   weight[coi * (ci * kh * kw) + cii * (kh * kw) + k_hi * kw + k_wi];
                        }
                    }
                }
            }
        }
        grad_in[idx] = sum;
    }
}

extern "C" __global__ void conv2d_grad_weight_kernel(
    float* grad_weight, const float* grad_out, const float* in,
    int n, int ci, int h, int w,
    int co, int kh, int kw,
    int oh, int ow,
    int stride, int padding
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total = co * ci * kh * kw;
    if (idx < total) {
        int coi = idx / (ci * kh * kw);
        int cii = (idx / (kh * kw)) % ci;
        int k_hi = (idx / kw) % kh;
        int k_wi = idx % kw;

        float sum = 0.0f;
        for (int ni = 0; ni < n; ++ni) {
            for (int hi = 0; hi < oh; ++hi) {
                for (int wi = 0; wi < ow; ++wi) {
                    int in_h = hi * stride + k_hi - padding;
                    int in_w = wi * stride + k_wi - padding;
                    if (in_h >= 0 && in_h < h && in_w >= 0 && in_w < w) {
                        sum += grad_out[ni * (co * oh * ow) + coi * (oh * ow) + hi * ow + wi] *
                               in[ni * (ci * h * w) + cii * (h * w) + in_h * w + in_w];
                    }
                }
            }
        }
        grad_weight[idx] = sum;
    }
}

extern "C" __global__ void max_pool2d_backward_kernel(
    float* grad_in, const float* grad_out, const float* in,
    int n, int c, int h, int w,
    int oh, int ow,
    int kh, int kw,
    int stride
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total = n * c * oh * ow;
    if (idx < total) {
        int ni = idx / (c * oh * ow);
        int ci = (idx / (oh * ow)) % c;
        int hi = (idx / ow) % oh;
        int wi = idx % ow;

        float g_out = grad_out[idx];
        
        float max_val = -1e38f;
        int max_h = 0;
        int max_w = 0;
        
        for (int kh_i = 0; kh_i < kh; ++kh_i) {
            for (int kw_i = 0; kw_i < kw; ++kw_i) {
                int cur_h = hi * stride + kh_i;
                int cur_w = wi * stride + kw_i;
                if (cur_h < h && cur_w < w) {
                    float val = in[ni * (c * h * w) + ci * (h * w) + cur_h * w + cur_w];
                    if (val > max_val) {
                        max_val = val;
                        max_h = cur_h;
                        max_w = cur_w;
                    }
                }
            }
        }
        
        // Since different output regions might map to same input (if stride < kernel), 
        // we should theoretically use atomicAdd. But for standard max pool (stride == kernel), 
        // it's not strictly necessary. We use atomicAdd for robustness.
        atomicAdd(&grad_in[ni * (c * h * w) + ci * (h * w) + max_h * w + max_w], g_out);
    }
}

extern "C" __global__ void sgd_update_kernel(float* param, const float* grad, float lr, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        param[i] -= lr * grad[i];
    }
}
"#;
