# Projeto: Smart Vacuum Cleaner (NEAT/Evolution)

## Visão Geral
Uma simulação de aspirador de pó robótico inteligente onde cada agente controla um robô aspirador que navega por uma sala cheia de poeira, obstáculos (móveis) e uma estação de carregamento. O objetivo é evoluir uma rede neural capaz de limpar a maior área possível, evitar colisões e gerenciar a bateria retornando à base antes de ficar sem energia.

## Mecânicas da Simulação

### Ambiente (A Sala)
- **Mapa de Poeira:** A sala é dividida em células; ~60% começam sujas, com clusters de poeira concentrada.
- **Obstáculos:** Móveis retangulares (sofá, mesa, estante) posicionados aleatoriamente que bloqueiam passagem.
- **Estação de Carga:** Posição fixa (canto inferior-esquerdo); o aspirador deve retornar para recarregar.
- **Paredes:** Bordas da sala que causam colisão e penalidade de fitness.

### O Aspirador (O Agente)
- **Posição:** Coordenadas (x, y) em espaço contínuo.
- **Heading:** Ângulo de direção (radianos) — determina a frente do robô.
- **Bateria:** Capacidade [0..1]; movimentação drena energia, limpeza custa um pouco mais, idle custa menos.
- **Sensores:** Raycasting para detectar poeira e obstáculos em 3 direções (frente, esquerda, direita).
- **Morte:** Se a bateria chega a 0 longe do carregador, o agente morre.

## Especificação da Rede Neural

### Inputs (9 neurônios)
1. **Poeira à Frente:** Densidade de poeira na direção frontal (normalizado).
2. **Poeira à Esquerda:** Densidade de poeira à esquerda (normalizado).
3. **Poeira à Direita:** Densidade de poeira à direita (normalizado).
4. **Obstáculo à Frente:** Distância ao obstáculo mais próximo na frente (1 = longe, 0 = colisão).
5. **Bateria:** Nível atual de carga [0..1].
6. **Distância ao Carregador:** Distância normalizada até a estação de carga.
7. **Ângulo ao Carregador:** Ângulo relativo ao heading atual (normalizado [-1..1]).
8. **sin(heading):** Codificação cíclica da direção.
9. **cos(heading):** Codificação cíclica da direção.

### Outputs (3 neurônios)
1. **Avançar (Forward):** Intensidade do movimento para frente [0..1].
2. **Virar Esquerda (Turn Left):** Intensidade da rotação à esquerda [0..1].
3. **Virar Direita (Turn Right):** Intensidade da rotação à direita [0..1].

## Função de Fitness
O objetivo é maximizar limpeza e eficiência:
$$Fitness = \frac{PoeirLimpa}{TotalPoeira} \times 10 + BônusBateria - PenalidadeColisão - PenalidadeMorte$$

> [!TIP]
> O **BônusBateria** (+2.0 se retornou ao carregador com >10% de carga) incentiva o agente a aprender gerenciamento de energia, não apenas limpeza agressiva.

## Visualização (Demo Web)
- Vista top-down da sala com piso, poeira (partículas), móveis e estação de carga.
- Os melhores agentes visíveis como robôs circulares com indicador de heading.
- Trilhas de limpeza mostrando o caminho percorrido.
- Raios de sensores visíveis no melhor agente.
- Mini-mapa de cobertura de poeira (heatmap).
- Gráficos de performance em tempo real (fitness max/avg por geração).
