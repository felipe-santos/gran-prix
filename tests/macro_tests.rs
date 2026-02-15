use gran_prix::graph::Graph;
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::{model, linear};
use ndarray::array;

#[test]
fn test_dsl_macros() {
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    
    let target = model!(&mut graph, g => {
        let x = g.val(array![[1.0, 2.0]].into_dyn());
        let w = g.param(array![[0.5, 0.1], [0.2, 0.4]].into_dyn());
        let b = g.param(array![[0.1, 0.1]].into_dyn());
        linear!(g, x, w, b)
    });

    let result = graph.execute(target).unwrap();
    // x * w + b = [[1, 2]] * [[0.5, 0.1], [0.2, 0.4]] + [[0.1, 0.1]]
    // = [[0.5 + 0.4, 0.1 + 0.8]] + [[0.1, 0.1]] = [[0.9 + 0.1, 0.9 + 0.1]] = [[1.0, 1.0]]
    assert_eq!(result, array![[1.0, 1.0]].into_dyn());
}
