use crate::backend::Backend;
use crate::Tensor;
use anyhow::Result;
use ndarray::Zip;

pub struct CPUBackend;

impl Backend for CPUBackend {
    fn name(&self) -> &str {
        "CPU (SIMD + Rayon)"
    }

    fn matmul_t(&self, a: &Tensor, b: &Tensor, trans_a: bool, trans_b: bool) -> Result<Tensor> {
        let lhs = if trans_a { a.t() } else { a.view() };
        let rhs = if trans_b { b.t() } else { b.view() };
        Ok(lhs.dot(&rhs))
    }

    fn add(&self, a: &Tensor, b: &Tensor) -> Result<Tensor> {
        Ok(a + b)
    }

    fn sigmoid(&self, x: &Tensor) -> Result<Tensor> {
        // Parallel map using Rayon (ndarray supports this via par_mapv)
        use ndarray::Zip;
        let mut res = x.clone();
        Zip::from(&mut res).par_for_each(|v| {
            *v = 1.0 / (1.0 + (-*v).exp());
        });
        Ok(res)
    }

    fn relu(&self, x: &Tensor) -> Result<Tensor> {
        let mut res = x.clone();
        Zip::from(&mut res).par_for_each(|v| {
            if *v < 0.0 { *v = 0.0; }
        });
        Ok(res)
    }

    fn add_relu(&self, a: &Tensor, b: &Tensor) -> Result<Tensor> {
        use ndarray::Zip;
        let mut res = a.clone();
        Zip::from(&mut res).and(b).par_for_each(|r, &bi| {
            let sum = *r + bi;
            *r = if sum < 0.0 { 0.0 } else { sum };
        });
        Ok(res)
    }
}
