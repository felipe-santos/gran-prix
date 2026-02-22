# 🦀 FASE 2: WASM Modularization Plan

## 📊 Análise Atual

**Arquivo:** `gran-prix-wasm/src/lib.rs`
**Linhas:** 725 linhas
**Status:** ⚠️ **Monolítico** - tudo em um único arquivo

### Estruturas Identificadas

```rust
// linha 27
pub enum MutationStrategy { Additive, Multiplicative, Reset }

// linha 36-382
pub struct NeuralBrain { ... }
impl NeuralBrain {
    new(), compute(), get_weights(), set_weights(), mutate(), clone_brain()
}

// linha 382-402
impl XorShift { next_f32() }  // RNG para mutação

// linha 403-543
pub struct Population { ... }
impl Population {
    new(), evolve(), get_agent_weights(), set_agent_weights(),
    get_fitness(), clone_agent()
}

// linha 543-725
pub struct Trainer { ... }
impl Trainer {
    new(), step(), get_loss(), set_lr(), get_batch(), set_labels()
}
```

---

## 🎯 Problemas Identificados

### 1. **Violação do SRP (Single Responsibility Principle)**
- Um arquivo com múltiplas responsabilidades:
  - Neural network (NeuralBrain)
  - Evolution/Mutation (Population, MutationStrategy)
  - Training/Optimization (Trainer)
  - Random number generation (XorShift)

### 2. **Difícil Navegação**
- 725 linhas em um único arquivo
- Estruturas misturadas
- Difícil encontrar código específico

### 3. **Baixa Testabilidade**
- Não é possível testar módulos isoladamente
- Acoplamento forte entre componentes

### 4. **Manutenibilidade Reduzida**
- Mudanças em uma área podem afetar outras
- Difícil trabalhar em equipe (merge conflicts)

---

## 🏗️ Arquitetura Proposta

### Estrutura de Módulos

```
gran-prix-wasm/src/
├── lib.rs                  # 50-80 linhas - Re-exports e init
├── brain.rs                # ~250 linhas - NeuralBrain
├── population.rs           # ~200 linhas - Population & Evolution
├── trainer.rs              # ~200 linhas - Trainer & Optimization
├── mutation.rs             # ~50 linhas - MutationStrategy & XorShift
└── utils.rs                # ~30 linhas - Helpers (se necessário)
```

---

## 📁 Detalhamento dos Módulos

### **lib.rs** (50-80 linhas)
```rust
// Re-exports públicos
pub mod brain;
pub mod population;
pub mod trainer;
pub mod mutation;

pub use brain::NeuralBrain;
pub use population::Population;
pub use trainer::Trainer;
pub use mutation::MutationStrategy;

#[wasm_bindgen]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}
```

**Responsabilidade:** Orquestração e re-exports

---

### **brain.rs** (~250 linhas)
```rust
use wasm_bindgen::prelude::*;
use gran_prix::{Tensor, Graph};
// ...

#[wasm_bindgen]
pub struct NeuralBrain {
    graph: RefCell<Graph>,
    input_node: usize,
    output_node: usize,
    input_tensor: RefCell<Tensor>,
    magic: u32,
    computing: RefCell<bool>,
    custom_kernel: RefCell<Vec<f32>>,
}

#[wasm_bindgen]
impl NeuralBrain {
    #[wasm_bindgen(constructor)]
    pub fn new(...) -> Result<NeuralBrain, JsValue> { ... }

    pub fn compute(&self, inputs: &[f32]) -> Result<Vec<f32>, JsValue> { ... }

    pub fn get_weights(&self) -> Vec<f32> { ... }

    pub fn set_weights(&mut self, weights: &[f32]) -> Result<(), JsValue> { ... }

    pub fn mutate(&mut self, rate: f32, scale: f32, strategy: MutationStrategy, rng: &mut XorShift) { ... }

    pub fn clone_brain(&self) -> Result<NeuralBrain, JsValue> { ... }
}
```

**Responsabilidade:**
- Construção de redes neurais
- Forward pass (compute)
- Serialização de pesos (get/set weights)
- Clonagem de cérebros

**Linhas estimadas:** ~250

---

### **mutation.rs** (~50 linhas)
```rust
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[derive(Copy, Clone)]
pub enum MutationStrategy {
    Additive,
    Multiplicative,
    Reset,
}

/// Fast pseudo-random number generator for mutation
pub struct XorShift {
    state: u64,
}

impl XorShift {
    pub fn new(seed: u64) -> Self {
        XorShift { state: seed }
    }

    pub fn next_f32(&mut self) -> f32 {
        self.state ^= self.state << 13;
        self.state ^= self.state >> 7;
        self.state ^= self.state << 17;
        (self.state as f32 / u64::MAX as f32)
    }
}

impl MutationStrategy {
    pub(crate) fn apply(&self, weight: f32, scale: f32, rng: &mut XorShift) -> f32 {
        match self {
            MutationStrategy::Additive => weight + (rng.next_f32() - 0.5) * scale,
            MutationStrategy::Multiplicative => weight * (1.0 + (rng.next_f32() - 0.5) * scale),
            MutationStrategy::Reset => (rng.next_f32() - 0.5) * scale,
        }
    }
}
```

**Responsabilidade:**
- Estratégias de mutação
- Geração de números aleatórios (XorShift)
- Lógica de aplicação de mutação

**Linhas estimadas:** ~50

---

### **population.rs** (~200 linhas)
```rust
use wasm_bindgen::prelude::*;
use crate::brain::NeuralBrain;
use crate::mutation::{MutationStrategy, XorShift};

#[wasm_bindgen]
pub struct Population {
    agents: Vec<NeuralBrain>,
    fitness: Vec<f32>,
    num_inputs: usize,
    num_hidden: usize,
    num_outputs: usize,
}

#[wasm_bindgen]
impl Population {
    #[wasm_bindgen(constructor)]
    pub fn new(size: usize, inputs: usize, hidden: usize, outputs: usize) -> Result<Population, JsValue> {
        let mut agents = Vec::with_capacity(size);
        for i in 0..size {
            agents.push(NeuralBrain::new(i, inputs, hidden, outputs)?);
        }

        Ok(Population {
            agents,
            fitness: vec![0.0; size],
            num_inputs: inputs,
            num_hidden: hidden,
            num_outputs: outputs,
        })
    }

    pub fn evolve(
        &mut self,
        fitness_scores: &[f32],
        mutation_rate: f32,
        mutation_scale: f32,
        strategy: MutationStrategy,
    ) -> Result<(), JsValue> {
        // Tournament selection
        // Elitism
        // Mutation
        // ...
    }

    pub fn get_agent_weights(&self, index: usize) -> Vec<f32> { ... }

    pub fn set_agent_weights(&mut self, index: usize, weights: &[f32]) -> Result<(), JsValue> { ... }

    pub fn get_fitness(&self, index: usize) -> f32 { ... }

    pub fn clone_agent(&self, index: usize) -> Result<NeuralBrain, JsValue> { ... }
}
```

**Responsabilidade:**
- Gerenciamento de populações de agentes
- Algoritmo de evolução (seleção, elitismo, cruzamento)
- Fitness tracking
- Operações em lote (get/set weights para múltiplos agentes)

**Linhas estimadas:** ~200

---

### **trainer.rs** (~200 linhas)
```rust
use wasm_bindgen::prelude::*;
use gran_prix::{Tensor, Graph, Loss};
use crate::brain::NeuralBrain;

#[wasm_bindgen]
pub struct Trainer {
    brain: NeuralBrain,
    optimizer_state: OptimizerState,
    learning_rate: f32,
    batch_data: Vec<f32>,
    batch_labels: Vec<f32>,
}

struct OptimizerState {
    // Adam/SGD state
    velocities: Vec<f32>,
    momentums: Vec<f32>,
}

#[wasm_bindgen]
impl Trainer {
    #[wasm_bindgen(constructor)]
    pub fn new(inputs: usize, hidden: usize, outputs: usize, lr: f32) -> Result<Trainer, JsValue> {
        let brain = NeuralBrain::new(0, inputs, hidden, outputs)?;

        Ok(Trainer {
            brain,
            optimizer_state: OptimizerState::new(),
            learning_rate: lr,
            batch_data: Vec::new(),
            batch_labels: Vec::new(),
        })
    }

    pub fn step(&mut self) -> Result<f32, JsValue> {
        // Forward pass
        // Backward pass (gradients)
        // Update weights (optimizer step)
        // Return loss
    }

    pub fn get_loss(&self) -> f32 { ... }

    pub fn set_lr(&mut self, lr: f32) { ... }

    pub fn get_batch(&self) -> Vec<f32> { ... }

    pub fn set_labels(&mut self, labels: &[f32]) { ... }
}
```

**Responsabilidade:**
- Treinamento supervisionado
- Otimização de pesos (SGD/Adam)
- Gerenciamento de batches
- Cálculo de loss

**Linhas estimadas:** ~200

---

## 🔄 Processo de Migração

### Fase 2A: Criar Módulos Base
1. ✅ Criar `mutation.rs` (mais simples)
2. ✅ Criar `brain.rs` (core)
3. ✅ Criar `population.rs` (depende de brain e mutation)
4. ✅ Criar `trainer.rs` (depende de brain)
5. ✅ Atualizar `lib.rs` (re-exports)

### Fase 2B: Validação
1. ✅ Verificar compilação (`cargo build --target wasm32-unknown-unknown`)
2. ✅ Rodar testes existentes
3. ✅ Verificar que WASM bindings funcionam
4. ✅ Testar demos no browser

### Fase 2C: Refinamento
1. ✅ Adicionar documentação Rust (///)
2. ✅ Otimizar imports
3. ✅ Criar testes unitários para cada módulo
4. ✅ Atualizar README

---

## 📊 Benefícios Esperados

### 1. **Organização**
```
Antes: 1 arquivo com 725 linhas
Depois: 5 arquivos com ~100-250 linhas cada
```

### 2. **Manutenibilidade**
- Módulos independentes e testáveis
- Separation of concerns clara
- Fácil localizar e modificar código

### 3. **Escalabilidade**
- Fácil adicionar novos tipos de mutation
- Fácil implementar novos otimizadores
- Arquitetura de brains pode evoluir independentemente

### 4. **Trabalho em Equipe**
- Menos merge conflicts
- Responsabilidades claras
- Code review mais fácil

### 5. **Performance**
- Compilação incremental mais rápida
- Tree-shaking mais efetivo
- WASM bundle potencialmente menor

---

## ⚠️ Riscos e Mitigação

### Risco 1: Breaking Changes no WASM
**Mitigação:**
- Manter mesmos nomes públicos
- Re-exports em lib.rs garantem compatibilidade
- Testar todos os demos após migração

### Risco 2: Overhead de Modules
**Mitigação:**
- Rust inline e LTO eliminam overhead
- WASM é compilado para código otimizado
- Benchmarks antes/depois para validar

### Risco 3: Complexidade de Build
**Mitigação:**
- Cargo gerencia automaticamente
- Sem mudanças no processo de build
- CI/CD continua funcionando

---

## 📈 Métricas de Sucesso

| Métrica | Antes | Meta | Status |
|---------|-------|------|--------|
| **Linhas por arquivo** | 725 | <300 | ⏳ Pendente |
| **Módulos independentes** | 0 | 4-5 | ⏳ Pendente |
| **Compilação OK** | ✅ | ✅ | ⏳ Pendente |
| **Testes passando** | ✅ | ✅ | ⏳ Pendente |
| **Demos funcionando** | ✅ | ✅ | ⏳ Pendente |
| **Documentação** | Mínima | Completa | ⏳ Pendente |

---

## 🚀 Próximos Passos

### Imediato
1. **Criar `mutation.rs`** - Módulo mais simples para começar
2. **Criar `brain.rs`** - Core do sistema
3. **Criar `population.rs`** - Evolução
4. **Criar `trainer.rs`** - Treinamento
5. **Atualizar `lib.rs`** - Re-exports

### Validação
1. `cargo build --release --target wasm32-unknown-unknown`
2. `wasm-pack build --target web`
3. Testar VacuumDemo, DroneDemo, WalkerDemo
4. Verificar performance (benchmarks)

### Documentação
1. Adicionar /// doc comments em funções públicas
2. Atualizar REFACTORING_PHASE_2_REPORT.md
3. Criar exemplos de uso para cada módulo

---

## ✍️ Conclusão

A modularização do WASM seguirá os mesmos princípios de qualidade aplicados na FASE 1:
- **Single Responsibility Principle**
- **DRY (Don't Repeat Yourself)**
- **Separation of Concerns**
- **Zero Breaking Changes**
- **Documentação Completa**

**Estimativa de tempo:** 2-3 horas
**Risco:** 🟢 **BAIXO** (refatoração estrutural pura)
**Impacto:** 🟢 **POSITIVO** (manutenibilidade e escalabilidade)

---

_Plano criado por: Claude Sonnet 4.5 (AI Senior Developer)_
_Data: 2026-02-21_
_Status: Pronto para execução_
