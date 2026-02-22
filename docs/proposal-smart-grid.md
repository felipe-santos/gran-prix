# Projeto: Smart Grid Optimization (NEAT/Evolution)

## Visão Geral
Uma simulação de gerenciamento inteligente de energia onde cada agente controla uma "Smart Home" equipada com painéis solares, uma bateria de armazenamento e conexão com a rede elétrica pública. O objetivo é evoluir uma rede neural capaz de tomar decisões de carga/descarga que minimizem o custo da conta de luz e maximizem a eficiência energética.

## Mecânicas da Simulação

### Ambiente
- **Ciclo Dia/Noite:** Influencia diretamente a geração solar (pico ao meio-dia, zero à noite).
- **Curva de Demanda:** O consumo da casa varia (picos de manhã e à noite, baixo de madrugada).
- **Preço Dinâmico:** A rede elétrica cobra mais caro em horários de pico (ex: 18h-21h) e menos em horários de baixa (madrugada).
- **Clima:** Nuvens aleatórias podem reduzir a eficiência solar temporariamente.

### A Smart Home (O Agente)
- **Bateria:** Tem capacidade limitada (kWh) e eficiência de carga/descarga (perda de calor).
- **Painéis Solares:** Geram energia "grátis" quando há sol.
- **Rede (Grid):** Pode fornecer energia ilimitada (custo $) ou comprar o excesso (crédito $$, geralmente menor que o custo de compra).

## Especificação da Rede Neural

### Inputs (8 a 10 neurônios)
1. **Geração Solar Atual (kW):** Quanto os painéis estão produzindo.
2. **Consumo da Casa (kW):** Demanda atual da residência.
3. **Carga da Bateria (%):** Estado atual do armazenamento.
4. **Preço da Rede ($/kWh):** Preço atual da energia pública.
5. **Hora do Dia (seno):** Para percepção de tempo/ciclo.
6. **Hora do Dia (cosseno):** Para percepção de tempo/ciclo.
7. **Tendência de Preço:** Se o preço vai subir ou descer na próxima hora (previsão).
8. **Previsão Solar:** Expectativa de sol para a próxima hora.

### Outputs (3 neurônios)
1. **Ação de Carga:** Carregar a bateria usando o excedente solar ou energia da rede (se estiver barata).
2. **Ação de Descarga:** Usar a bateria para alimentar a casa (evitando comprar da rede cara).
3. **Venda/Idle:** Vender o excedente para a rede ou não fazer nada.

## Função de Fitness
O objetivo é a minimização de custos:
$$Fitness = \frac{1}{\sum (EnergiaComprada \times Preço) - \sum (EnergiaVendida \times Crédito) + 1}$$

> [!TIP]
> Também podemos adicionar uma penalidade por "Ciclos de Bateria" inúteis para evoluir agentes que preservam a vida útil do hardware.

## Visualização (Demo Web)
- Um painel com várias casas em miniatura.
- Gráfico em tempo real de: Preço da Rede vs. Carga da Bateria.
- Indicadores visuais de fluxo de energia (setas animadas entre Sol -> Casa -> Bateria -> Rede).
