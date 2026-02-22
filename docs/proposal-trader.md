# Projeto: AI Trader Evolution (Séries Temporais)

## Visão Geral
Uma simulação de mercado financeiro onde agentes (bots de trade) competem para maximizar seu patrimônio operando um ativo volátil. Em vez de backtesting estático, os agentes evoluem estratégias de tomada de decisão baseadas em indicadores técnicos clássicos.

## Mecânicas da Simulação

### Ambiente (O Mercado)
- **Preço:** Gerado via Geometric Brownian Motion (GBM) ou carregado de um CSV real.
- **Janela de Tempo:** A simulação ocorre em "ticks" (ex: velas de 1 minuto).
- **Taxas:** Cada operação de compra/venda tem uma pequena taxa de corretagem (slippage/fee), impedindo estratégias de "spamming" de ordens.

### O Trader (O Agente)
- **Capital Inicial:** Todos começam com o mesmo valor (ex: $10.000).
- **Posição:** Pode estar "Comprado" (Long), "Vendido" (Short - opcional p/ complexidade) ou em "Caixa" (Neutral).
- **Risco:** O agente decide o momento da entrada e saída.

## Especificação da Rede Neural

### Inputs (7 neurônios)
1. **Retorno Logístico:** Variação percentual do preço no último tick.
2. **RSI (7):** Identificador de sobrecompra ou sobrevenda.
3. **Cruzamento de Médias:** Diferença entre uma média móvel curta (7) e uma longa (25).
4. **Volatilidade (ATR):** Para adaptação a mercados calmos vs. agitados.
5. **Estado da Posição:** Neurônio binário ou categórico (-1 Short, 0 Cash, 1 Long).
6. **P&L Aberto:** Lucro ou prejuízo da operação atual.
7. **Drawdown:** Distância do pico de capital alcançado.

### Outputs (3 neurônios)
1. **Comprar / Aumentar:** Sinal para entrar ou manter posição comprada.
2. **Vender / Fechar:** Sinal para sair da posição ou entrar vendido.
3. **Aguardar (Hold):** Manter o estado atual sem operações.

## Função de Fitness
$$Fitness = \frac{Saldo Final}{Saldo Inicial} \times (1 - MaxDrawdown)$$

> [!IMPORTANT]
> A inclusão do **MaxDrawdown** (maior queda do pico) na fórmula é vital para evoluir agentes que não são apenas "sortudos" em tendências, mas que sabem gerenciar o risco em quedas.

## Visualização (Demo Web)
- Gráfico de Candlestick em tempo real.
- Marcadores (setas verdes/vermelhas) onde o melhor agente da geração operou.
- Leaderboard de "ROI" e "Sharpe Ratio" dos agentes.
