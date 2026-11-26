# @gran-prix/studio (`gp-studio`)

A interface de rotulagem humana do experimento DOM (E2.4) e o lugar onde o dono faz as **tarefas humanas** do
protocolo: calibração, prompt-dev, auditoria, reteste e as revisões. Cada página capturada é rotulada, quase só
com o teclado, em 3 classes (**main / support / noise**, ou principal / suporte / ruído) mais as marcas **doubt**
(dúvida) e **mixed** (misto). O Studio exporta `NodeLabels` válidos pelo contrato, com `source=human`. Os rótulos
seguem o guia de anotação (`IDEIAS/plano/guia-de-anotacao.md`, congelado depois da calibração); a interface só
resume o guia num painel de consulta e nunca o altera.

**Privacidade: só local.** O servidor escuta apenas em `127.0.0.1`, é protegido por um token aleatório por sessão
e nada sai da máquina: sem chamadas de rede, sem telemetria, sem CDN. As páginas capturadas aparecem num frame
isolado que não executa scripts nem carrega nada da rede. Páginas logadas (guia 4.6b) são rotuladas só com esta
ferramenta.

## Como iniciar

```bash
pnpm install
pnpm -r build                       # o servidor importa o dist dos pacotes; o Studio gera dist/ + dist/ui

# as páginas vêm de um `collect` (gp run ... --data-dir data); o Studio só lê esse data dir
node tools/studio/dist/bin.js --data-dir data --annotator seu-nome --port 4817
```

O comando imprime uma URL como `http://127.0.0.1:4817/?token=AbC...`. O **token** é a chave da sessão: quem o vê e
alcança a sua máquina lê as páginas. Ele muda a cada início do Studio: depois de reiniciar, use a URL nova. Para
parar, `Ctrl+C`.

| opção | significado |
|---|---|
| `--data-dir <dir>` | data dir do `gp` cujo repositório de artefatos (`<dir>/artifacts`) guarda o(s) SnapshotSet(s) a rotular. Padrão: `data` |
| `--annotator <nome>` | quem rotula; os arquivos vão para `<data-dir>/human-labels/<nome>/` e viram `labeler.id = human@<nome>`. Padrão: seu login. Letras, dígitos, `.`, `_`, `-` |
| `--port <n>` | porta em 127.0.0.1. Padrão: uma livre. **Fixe uma porta** (por exemplo 4817) para o encaminhamento do VS Code (ver abaixo) |
| `--queues-dir <dir>` | pasta das filas `<tarefa>.json`. Padrão: `<data-dir>/labeling/queues` |
| `--fixtures-dir <dir>` | `fixtures/pages` do repositório, de onde a calibração lê os `truth.json`. Padrão: o do próprio checkout |
| `--default-mode blind\|review` | modo das páginas do modo livre ainda não abertas. Padrão `blind`: nenhum rascunho aparece |
| `--guide <arquivo>` | serve o guia como texto, para o painel de consulta poder linkar |

O Studio é um bin próprio (`gp-studio`), não um subcomando de `gp`: `tools/cli` não depende do Studio (e não deve:
o Studio lê o mesmo repositório que o cli escreve).

### Abrir no navegador do seu computador (VS Code Remote)

O Studio roda na máquina remota e escuta só em `127.0.0.1`; o navegador está no seu computador. A ponte é o
**encaminhamento de portas** do VS Code:

1. Inicie o Studio no terminal do VS Code Remote **com `--port 4817`** (ou outra fixa).
2. O VS Code costuma detectar a porta sozinho ("Your application running on port 4817 is available"). Se não,
   abra o painel **Portas** (aba ao lado de Terminal; ou `Ctrl+Shift+P` e "Ports: Focus on Ports View"), clique em
   **Forward a Port** e digite `4817`.
3. Olhe a coluna **Local Address** do painel: tem de ser `localhost:4817`, **o mesmo número** da porta remota.
4. No seu navegador abra a URL completa que o Studio imprimiu, com o token: `http://localhost:4817/?token=...`
   (ou `Ctrl+clique` na URL do terminal; ou o ícone de globo na linha da porta, e então acrescente `?token=...`).

Atenção: o Studio só atende pedidos cujo cabeçalho `Host` seja `127.0.0.1:<porta>` ou `localhost:<porta>` (defesa
contra DNS rebinding). Se a porta local encaminhada for **diferente** da remota (o VS Code escolhe outra quando a
porta local está ocupada, por exemplo `localhost:4818`), o Studio responde `403 bad Host header`. Solução: libere
a porta local, ou reinicie o Studio com outra `--port` que esteja livre também no seu computador.

## A ordem das tarefas

A tela inicial lista as tarefas na ordem do protocolo (`experimento-dom-v0.md` §5.1). Cada uma mostra o progresso
(feitas / total), o tempo ativo acumulado, a próxima página e o estado.

| # | tarefa | o que é | tempo (§5.6) |
|---|---|---|---|
| 1 | **calibração** | os 12 grupos do guia §7, nos fixtures sintéticos, cego. Critério: ≥ 11/12 em keep × drop e ≥ 10/12 em 3 classes | guia + calibração: **0,5 h** |
| 2 | **prompt-dev** | 10 páginas do treino, rótulo seu do zero, cego | 10 × 7 min = **1,2 h** |
| 3 | **auditoria** | 30 páginas do teste (5 por categoria), rótulo seu do zero, cego ao LLM e aos extratores | 30 × 7 min = **3,5 h** |
| 4 | **reteste** | 10 páginas da auditoria de novo, **só depois de ≥ 7 dias**, cego ao primeiro rótulo (κ intra-anotador ≥ 0,85) | 10 × 6 min = **1,0 h** |
| 5 | **test-review** | as ~21 páginas restantes do teste: rascunho do LLM revisado em 100% dos nós | 21 × 4 min = **1,4 h** |
| 6 | **train-sample** | ~9 páginas do treino (10%), revisão completa do rascunho | 9 × 4 min = **0,6 h** |

As páginas logadas (12 × 7 min = 1,4 h) são rotuladas à parte, só por você, no modo livre. O total estimado da E2 é
**cerca de 9,6 h**; os tempos por página são estimativas **[NV]**: meça nas 3 primeiras e reestime (o tempo real
aparece na tela inicial). A ordem do protocolo importa (a calibração antes de congelar o guia, o prompt-dev antes de o
prompt ser congelado, a auditoria depois do prompt congelado), mas **o Studio não impõe a ordem entre tarefas**: ele
impõe as regras de cada tarefa (cegueira, `not_before`, formato da fila). Quem faz cumprir a ordem é o plano.

### As filas (contrato com a lane do plano de rotulagem)

Cada tarefa lê `data/labeling/queues/<tarefa>.json` (ou `--queues-dir`). O arquivo é gerado pela lane L4f e o
formato **não muda**:

```json
{"format":"gran-prix.label-queue","format_version":"1.0.0","task":"audit","mode":"blind",
 "plan_sha256":"sha256:...","not_before":null,
 "pages":[{"snapshot_id":"sha256:...","url":"...","category":"article","split":"test"}]}
```

`task` é `prompt-dev`, `audit`, `retest`, `train-sample` ou `test-review`; `mode` é `blind` ou `review`;
`not_before` é `null` ou uma data ISO. A leitura é estrita: um arquivo fora do formato **não vira tarefa**; ele
aparece num aviso vermelho na tela inicial com o motivo, e nunca é aberto. Além do formato, o Studio recusa uma fila
em que `prompt-dev`, `audit` ou `retest` não seja `blind` (são tarefas "do zero", §5.1), ou em que o nome do arquivo
não seja o nome da tarefa. As filas são relidas a cada vez que você abre a tela inicial. As páginas da fila têm de
estar no data dir (`collect` rodado); as que faltam aparecem como "não está no data dir".

## Regras de cegueira (§5.1.3)

Impostas **no servidor**, não só escondidas na tela:

* Numa tarefa `blind` o servidor **nunca** entrega rascunho, votos de extrator nem rótulo de LLM: a resposta da
  página não tem os campos `draft`/`drafts`, o parâmetro `?draft=` é ignorado, e pedir `mode: "review"` é recusado
  (409). O modo é da tarefa; não existe botão para trocá-lo.
* Os rótulos de cada tarefa ficam em pastas separadas (`human-labels/<nome>/tasks/<tarefa>/`): **o reteste não vê o
  primeiro rótulo da auditoria**, nem pela tela, nem por um NodeLabelsSet carregado como rascunho (rascunhos de
  `human@...` nunca são oferecidos).
* **Reteste:** o servidor recusa abrir a tarefa (qualquer rota, 403) antes de `not_before`, e a tela inicial a
  mostra "fechada até <data>". Se `not_before` for `null`, a tarefa abre sem restrição de data: confira que a fila
  do reteste traz a data (≥ 7 dias depois da auditoria).
* As páginas de uma fila `blind` **não aparecem no modo livre** ("Todas as páginas") nem aceitam rascunho por lá.
* Uma página que esteja numa fila `blind` e também numa fila `review` (por exemplo `audit` e `test-review`) é um
  conflito do plano: o Studio não a serve na fila `review` (409) e a marca na lista. Nenhum rascunho aparece para
  uma página que pertence a uma tarefa cega.
* O tempo de uma tarefa cega é registrado como `blind`, o que quer que o navegador envie.

Nas tarefas `review` (`train-sample`, `test-review`) o rascunho aparece (LLM > merge > readability/heurística >
regra; ou o Readability calculado na hora): `[M]` marca a proposta do rascunho, ainda não o seu rótulo. Depois de
você rotular uma unidade que difere dele, ela ganha contorno vermelho e o selo `S≠M`; `v` mostra só as divergências.
Nada conta até você confirmar (`c`/Enter por unidade ou subárvore, `Shift+C` para tudo o que falta, que pergunta antes).

## Calibração (guia §7)

Tarefa embutida (`calibration`), sempre cega, sobre os fixtures sintéticos de `fixtures/pages` coletados pelo
`collect`. Para ter as páginas no data dir:

```bash
node tools/cli/dist/bin.js run pipelines/dom-v0.json --to collect --data-dir data   # coleta os 12 fixtures
```

A tela da calibração lista os **12 grupos** da tabela do §7 (fixture + seletores, definidos em
`src/core/calibration.ts`). Abra o fixture, rotule os elementos do grupo (o painel lateral lista os seletores e
mostra a contagem de unidades rotuladas) e clique em **Terminar grupo**. Só então o Studio mostra o esperado, que
é o que o `truth.json` do fixture dá ao elemento (com as revisões R1 a R3 do guia):

* acertos de **keep × drop** e de **3 classes**, por grupo (um grupo só está certo se todas as suas unidades estão);
* o critério: **≥ 11/12 em keep × drop e ≥ 10/12 em 3 classes**, decidido quando os 12 grupos terminam;
* a lista dos erros (alvo, elemento, esperado, o seu rótulo, e se o erro é só de 3 classes), para discutir.

Antes de terminar o grupo nada do esperado sai do servidor. O resultado de um grupo terminado fica **congelado** em
`human-labels/<nome>/tasks/calibration/calibration.json`: rotular de novo depois não o muda. Alvos que não são
renderizados (`#subscribe-modal`, `.stealth`, `#beta-popup`) estão fora de U: não há o que rotular neles e contam
como certos. Os rótulos da calibração não são exportados.

## O que se rotula (universo U)

A unidade é o elemento com texto próprio que está **renderizado** depois do settle, ou um **disclosure de conteúdo**
(`<details>` fechado, painel de aba inativo: `flags.disclosure` do snapshot, contratos v1.1; o Studio os abre no
frame para poderem ser clicados e os marca como *collapsed*). Elementos ocultos, fora da tela, `sr-only`, de tamanho
zero, `<head>` e texto de script/style estão fora de U e não são pedidos. Contêineres (sem texto próprio) também
aceitam rótulo, herdado por tudo abaixo até um descendente ter o seu (convenção do ancestral mais próximo, como nos
`truth.json` dos fixtures e no guia 2.2). A regra de "renderizado" e a lista de tags que nunca são conteúdo vêm de
`@gran-prix/markdown` (`isRenderedNode`, `NON_CONTENT_TAGS`): é a mesma definição do conversor de markdown.

## Teclado (clique num elemento contornado ou aperte `j` primeiro)

| tecla | ação |
|---|---|
| `1` / `2` / `3` | rotula o elemento selecionado **e a sua subárvore**: main / support / noise (e pula para a próxima unidade sem rótulo) |
| `Shift+1/2/3` | rotula **só** o elemento (os filhos que herdavam mantêm o rótulo que tinham) |
| `d` / `m` | liga/desliga **doubt** / **mixed**. Logo depois de uma tecla de rótulo valem para a unidade recém-rotulada |
| `j` / `k` | próxima / anterior unidade **sem rótulo** (dá a volta) |
| `Down` / `Up` | próxima / anterior unidade, rotulada ou não |
| `Left` ou `h` / `Right` ou `l` | seleciona o pai (sobe para o contêiner) / desce |
| `c` ou `Enter` | revisão: aceita o rascunho da unidade (ou de todas as unidades do contêiner) |
| `Shift+C` | revisão: aceita o rascunho de todas as unidades ainda sem rótulo (pergunta antes) |
| `x` / `Backspace` | apaga os rótulos da subárvore selecionada |
| `u` ou `Ctrl+Z` / `Shift+U` ou `Ctrl+Y` | desfazer / refazer |
| `e` | exporta esta página (não existe na calibração) |
| `v` | revisão: mostra só as divergências |
| `a` | liga/desliga o avanço automático |
| `g` / `?` | consulta rápida do guia / mapa de teclas |

Mouse: passar o mouse destaca o elemento (amarelo), clicar o seleciona (moldura preta) e mais nada acontece: links,
botões e formulários da página capturada não fazem nada. As classes são legíveis sem cor: **main** contorno sólido,
listras diagonais, selo `M`; **support** tracejado, pontos, `S`; **noise** pontilhado, linhas horizontais, `N`;
**sem rótulo** contorno duplo laranja. As marcas aparecem como `?` (dúvida) e `~` (misto); a paleta é Okabe-Ito.

## Como exportar

Pela tela de uma tarefa, **Exportar a tarefa** exporta todas as páginas completas dela; na página, `Export` (ou `e`)
exporta só aquela. O Studio **recusa exportar enquanto houver unidade de U sem rótulo**: nada é escrito e as
unidades que faltam são listadas (clique para ir até uma; `j` percorre as demais). O documento:

* `format: gran-prix.node-labels`, `label_space: multiclass [main, support, noise]`, `source: human`,
  `confidence: 1` em cada item, `labeler: { id: "human@<nome>", kind: "human" }`, itens ordenados por `unit_id`
  (= índice do nó, o id `n<k>`), `coverage: { n_labeled: |U|, n_candidates: |U| }`;
* as marcas viajam em `reason` (`doubt`, `mixed` ou `doubt,mixed`; guia 2.4);
* um bloco aberto `studio: { mode, guide_version, n_doubt, n_mixed, draft, task, plan_sha256 }` registra como os
  rótulos foram feitos. **`task` e `plan_sha256` vêm da fila** e entram no `labels_id` (o contrato de `NodeLabels` não
  tem campo de proveniência de tarefa; o bloco `studio` é a extensão aberta que o esquema aceita). Reexportar os
  mesmos rótulos dá o mesmo id (sem horários dentro); o rótulo do reteste nunca tem o id do rótulo da auditoria.

As exportações de uma tarefa ficam em `human-labels/<nome>/tasks/<tarefa>/export/labels/<hex12>.json`, que tem o
formato de um NodeLabelsSet e pode ser carregado como entrada externa de um pipeline. No modo livre, "Export all
complete pages" exporta todas as páginas completas e diz as que ficaram de fora.

## Onde ficam os arquivos

```
<data-dir>/human-labels/<nome>/
  <hex do snapshot>.json            estado de trabalho de uma página no MODO LIVRE (salvo sozinho)
  timelog.jsonl                     só anexa: {page, mode, start, end, seconds, annotator} por sessão
  export/labels/<hex12>.json        NodeLabels exportado (modo livre)
  tasks/<tarefa>/                   o mesmo layout, privado de cada tarefa (calibration, audit, retest, ...)
    calibration.json                (só na calibração) resultado congelado de cada grupo terminado
```

`<data-dir>/artifacts` é lido, nunca escrito. `human-labels/` fica sob `data/`, que está no `.gitignore` (nenhum
texto de página vai para o git). O leitor do SnapshotSet é o `SnapshotSetReader` de `@gran-prix/labels`, a mesma
classe que o `@gran-prix/cli` exporta.

## Registro de tempo

O cabeçalho da página mostra o tempo ativo nela e o total; a tela inicial mostra o acumulado por tarefa. O relógio
só conta um segundo enquanto a aba está visível e você mexeu no teclado ou no mouse nos últimos 60 s; cada sessão
de trabalho é anexada ao `timelog.jsonl` da tarefa quando você sai da página, esconde a aba ou fecha a janela (o
servidor limita `seconds` ao intervalo real da sessão). Some esse arquivo para o orçamento de horas humanas do
experimento (`experimento-dom-v0.md` §5.6).

## Modelo de segurança

* Só `127.0.0.1` (nunca `0.0.0.0`); o `Host` tem de ser `127.0.0.1:<porta>` ou `localhost:<porta>` (DNS rebinding);
  pedidos que mudam estado exigem o cabeçalho `X-Studio-Token`, tipo JSON e `Origin` do mesmo site (CSRF); os GET
  aceitam o token em `?token=` (primeiro carregamento, `src` do iframe).
* A página capturada é servida em `/api/pages/<hex>/frame` (ou `/api/tasks/<tarefa>/pages/<hex>/frame`) com
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; ...; sandbox
  allow-same-origin` e mostrada num `<iframe sandbox="allow-same-origin">` (sem `allow-scripts`): nenhum script roda,
  nada é buscado na rede, e o app desenha o contorno mudando atributos dos elementos do frame. O HTML nunca é
  interpolado no DOM do app.
* Caminhos de manifestos e URLs são verificados (sem `..`, sem absolutos, sem segmentos vazios); ids de snapshot têm 64
  caracteres hexadecimais; nomes de anotador e de tarefa têm um conjunto seguro de caracteres.
* A página do app tem `script-src 'self'`; as filas e os fixtures não carregam comandos (a ferramenta não executa nada).

## Desenvolvimento

```bash
pnpm --filter @gran-prix/studio test        # unitários + servidor + tarefas + calibração + smoke headless (precisa do Chromium)
pnpm --filter @gran-prix/studio typecheck   # precisa de contracts, labels, markdown e cli compilados (os tipos do dist)
```

Os testes rodam contra as fontes dos pacotes irmãos (sem build prévio do workspace), montam o bundle da UI uma vez e
rodam o estágio `collect` real sobre fixtures: duas páginas (article-1, product-2) para o corpo da suíte, e as 10 do
exercício de calibração para os testes de tarefa e de calibração. As filas dos testes são fixtures no formato do
contrato (`test/harness.ts`), não arquivos da L4f. Estrutura: `src/core` lógica pura compartilhada entre servidor e UI
(universo U, herança de rótulos, reducer do teclado, plano de exportação, definição e pontuação da calibração),
`src/server` servidor `http` do node e armazéns (`queues`, `task-routes`, `page-routes`, `calibration`, `human-store`),
`src/ui` app React. Limites conhecidos: o conteúdo de iframes de outras origens e Shadow DOM fechado não estão no snapshot
(guia 3.1); imagens e CSS externo da página capturada não aparecem; o link do guia só funciona com `--guide`.
