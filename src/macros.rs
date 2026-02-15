/// Declarative macro for building models quickly
#[macro_export]
macro_rules! model {
    ($graph:expr, $builder:ident => { $($body:tt)* }) => {
        {
            let mut $builder = $crate::graph::dsl::GraphBuilder::new($graph);
            $($body)*
        }
    };
}

/// Helper for linear layer in macro
#[macro_export]
macro_rules! linear {
    ($builder:ident, $x:expr, $w:expr, $b:expr) => {
        $builder.linear($x, $w, $b)
    };
}
