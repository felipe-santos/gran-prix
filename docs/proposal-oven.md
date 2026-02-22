# Projeto: Smart Oven (IoT Edge AI Demo)

## Visão Geral
Uma simulação de um **Forno Elétrico Inteligente** demonstrando o uso de Edge AI (Inteligência Artificial na borda) para controle termodinâmico de precisão. Em vez de definir uma temperatura, temperatura e fluxo de ar fixos, o forno monitora o processo de cozimento de diferentes alimentos (Bolo, Pão, Peru, Pizza) e uma rede neural local controla a potência das resistências (superior/inferior) e a convecção (ventilador) em tempo real para assar o centro perfeitamente, sem queimar a superfície.

## Mecânicas da Simulação (Termodinâmica Simplificada)

### O Ambiente (O Forno)
- **AirTemp (Temperatura do Ar):** Aquecida ativamente pelas resistências (Top/Bottom). Perde calor gradativamente para o ambiente se as resistências forem desligadas.
- **Top Heater (Resistência Superior):** Assa e "dora" rapidamente a superfície do alimento.
- **Bottom Heater (Resistência Inferior):** Cria uma base de calor mais constante.
- **Fan (Ventilador Convector):** Acelera a transferência de calor do ar (AirTemp) para a superfície do alimento (SurfaceTemp), ajudando a homogeneizar o forno, mas pode ressecar rapidamente.

### O Alimento
O prato a ser cozido possui duas camadas na simulação:
1. **SurfaceTemp (Superfície):** Esquenta rápido em contato direto com o ar quente e radiação. Queima se ultrapassar sua `BurnTemp` máxima.
2. **CoreTemp (Centro):** Esquenta lentamente através da transferência de calor da superfície. O objetivo é alcançar e manter a `TargetCoreTemp` perfeita.

### Tipos de Alimento
| Comida   | Target Core | Burn Surface | Inércia Térmica | Perfil |
|----------|-------------|--------------|-----------------|--------|
| **Bolo** | 95°C        | 160°C        | Média           | Delicado, não pode tostar muito por fora |
| **Pão**  | 95°C        | 210°C        | Alta            | Demora a assar no meio, crosta grossa  |
| **Peru** | 75°C        | 180°C        | Muito Alta     | Lento; superfície queima fácil antes de assar dentro |
| **Pizza**| 85°C        | 240°C        | Muito Baixa    | Muito rápido; precisa de alta radiação para base crocante |

## Especificação da Rede Neural (Cérebro Local IoT)

A rede neural é o controlador PID/termóstato super-avançado de borda.

### Inputs (11 neurônios)
_Sensores que o microcontrolador do forno leria da placa IoT_
1. **Ar Atual:** Temperatura atual do ar interno normalizada.
2. **Superfície Atual:** Temperatura da superfície do alimento normalizada.
3. **Core Atual:** Temperatura central do alimento normalizada (via termopar).
4. **Erro de Core:** Distância da temperatura atual do centro para a temperatura alvo (Target Core).
5. **Margem de Queima:** Distância da temperatura atual da superfície para o limiar de queima (Burn Surface).
6. **Tempo Passado:** Porcentagem do ciclo de cozimento já transcorrida.
7. **Is Cake:** 1 se for Bolo, 0 se não. (Codificação One-Hot para reconhecer a receita dinâmica).
8. **Is Bread:** 1 se for Pão, 0 se não.
9. **Is Turkey:** 1 se for Peru, 0 se não.
10. **Is Pizza:** 1 se for Pizza, 0 se não.
11. **Fan On:** Estado anterior do ventilador para manter inércia e evitar loop on/off maluco.

### Outputs (3 neurônios)
_Atuadores de estado contínuo mandando sinal PWM para a placa_
1. **Top Heater:** Potência da resistência superior [0.0 = Desligada, 1.0 = Máxima].
2. **Bottom Heater:** Potência da resistência inferior [0.0 = Desligada, 1.0 = Máxima].
3. **Fan:** Potência do ventilador convector [0 = Desligado, >0.5 = Ligado].

## Função de Fitness
O objetivo é garantir a perfeição gastronômica e economia de energia:
$$Fitness = BônusCore - PenalidadeQueima - PenalidadeSubcozido - PenalidadeSuor (Energia)$$

> [!CAUTION]
> A simulação pune severamente agentes que assam a comida por fora (queima a crosta) deixando congelado por dentro. Eles devem aprender padrões dinâmicos: pré-aquecer forte, abaixar ou desligar em pulsos (Pulse-Width Modulation improvisado com pesos ML) para o calor chegar ao `Core` delicadamente.
