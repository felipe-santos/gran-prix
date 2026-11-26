# Extensão de captura local (estrato `logged_in`, protocolo dom-v0 §2.5)

Uma extensão do Chrome, **só sua, carregada sem empacotar**, que roda na aba aberta o mesmo probe que o coletor do
Gran-Prix usa e **baixa dois arquivos para o seu disco**: o `PageSnapshot` (JSON) e o HTML renderizado compactado
(`html.gz`). Depois você leva esses arquivos para a máquina do projeto e roda um comando que os transforma no
estrato `logged_in` do corpus.

Isto é uma ferramenta de pesquisa para as 10 a 12 páginas logadas do experimento. **Não é o produto**: a extensão do
produto (E4) só começa se o experimento der GO.

## Aviso de privacidade (leia antes de capturar)

**O que é capturado.** Tudo o que está na página aberta, como o Chrome a renderiza para você:

- todo o texto visível (e-mails, documentos, mensagens, nomes, valores: o que estiver na tela ou no DOM);
- a estrutura da página (tags, classes, ids, `href`, `aria-label`, retângulos e estilos calculados);
- o HTML renderizado, sem o conteúdo dos `<script>`;
- a URL **sem** a query (`?...`) e sem o fragmento (`#...`), porque nos apps logados eles costumam carregar tokens e ids;
- o user agent e a versão do seu Chrome, o tamanho real da janela e a hora da captura.

**O que não é capturado.** Cookies, tokens, senhas digitadas, `localStorage`, cabeçalhos de rede, conteúdo de
`<iframe>` e de shadow roots fechados, imagens e arquivos. A extensão não tem permissão de rede e não envia nada a
lugar nenhum (veja "Como a extensão se limita" abaixo).

**Onde fica.** No seu computador: primeiro em `Downloads/gp-captures/`, depois (você copia) em
`data/corpus/logged-in/` da máquina do projeto. Essa pasta está no `.gitignore`: **nunca vai para o git**. Rótulos e
métricas dessas páginas também ficam locais, e **nenhum texto delas vai para LLM de nuvem** (protocolo §2.5, D12).
Só métricas agregadas saem do ambiente.

**O que você deve fazer.**

1. **Não envie esses arquivos a ninguém** (e-mail, chat, issue, gist, IA). Eles contêm o conteúdo da página.
2. Se uma página for sensível demais, **não a capture**; se capturou, apague os dois arquivos. O protocolo manda
   repor pela regra (próximo app ou próxima página mais recente), nunca por escolha sua.
3. Depois de importar, **apague `Downloads/gp-captures/`** do seu computador, principalmente se `Downloads` for
   sincronizado com Drive, Dropbox, iCloud ou OneDrive.
4. A extensão marca cada elemento da página com um atributo `data-gp-id` (é como o probe numera os nós). Isso só existe
   na aba aberta e some ao recarregar; a página em si não é alterada de outra forma.

## Passo a passo

### 0. Preparar (uma vez, na máquina do projeto)

```bash
pnpm install
pnpm -r build                                       # a extensão usa os pacotes já construídos
pnpm --filter @gran-prix/capture-extension build    # gera tools/capture-extension/dist/
```

A pasta pronta para carregar é `tools/capture-extension/dist/`. Como você usa o **VS Code Remote**, o Chrome roda no
seu computador e essa pasta está na máquina remota: no Explorer do VS Code, clique com o botão direito em `dist` e
escolha **Download...**; salve numa pasta sua (por exemplo `C:\gp\dist` ou `~/gp/dist`). Carregue a **cópia**.
(Se o projeto rodar na mesma máquina do Chrome, carregue `dist` direto.)

### 1. Carregar a extensão sem empacotar

1. No Chrome, abra `chrome://extensions`.
2. Ligue **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** e escolha a pasta `dist` (a cópia local).
4. A extensão **Gran-Prix: captura local** aparece na lista. Clique no ícone de quebra-cabeça da barra do Chrome e
   **fixe** a extensão, para ter o ícone sempre à mão.

Se você reconstruir (`build`) e baixar `dist` de novo, volte a `chrome://extensions` e clique em **Recarregar** na
extensão.

### 2. Escolher as páginas (regra do §2.5, sem escolher as "bonitas")

1. Pegue os **12 apps web autenticados mais usados nos últimos 30 dias** no histórico do navegador
   (`chrome://history`; conte as visitas por domínio, só apps em que você está logado: e-mail, documentos, tarefas,
   banco, chat, painel de trabalho etc.). O que vale é a regra, não a ferramenta: anote a lista **antes** de abrir
   qualquer página.
2. Para cada app, **1 página**: a **mais recentemente aberta** que **não** seja configuração, login ou cobrança.
3. Se uma página for sensível demais, descarte e reponha pela regra: próximo app da lista, ou a próxima página mais
   recente do mesmo app.
4. Meta: **12 páginas, de 12 apps diferentes** (o mínimo do protocolo é 10).

### 3. Capturar

1. Abra a página escolhida e espere ela terminar de carregar. Feche pop-ups e modais que você não queira na captura.
2. Clique no ícone da extensão. O popup mostra **Capturando...** por alguns segundos (a extensão espera o DOM ficar
   quieto por 0,6 s, no máximo 8 s) e depois **capturado: N nós, X KB**, com o aviso *"Fica no seu disco; não envie a
   ninguém."*
3. Dois arquivos aparecem em `Downloads/gp-captures/`, com o hash da captura no nome (nunca o título da página):

   ```
   <64 hex>.json       o PageSnapshot
   <64 hex>.html.gz    o HTML renderizado
   ```

4. Se o popup disser **Não capturou.**, leia a mensagem abaixo dele. Os casos comuns: a aba é `chrome://`, a Chrome Web
   Store, um arquivo local ou `about:blank` (a extensão só captura `http(s)`); ou você abriu o popup sem clicar no ícone
   (clique de novo, com a página aberta).
5. Se o Chrome perguntar onde salvar cada arquivo, desligue em `chrome://settings/downloads` ("Perguntar onde salvar
   cada arquivo antes de fazer download").
6. Se o popup mostrar "avisos: ..." (`captcha`, `paywall`, `error-page`, `tiny-dom`), a página provavelmente não é a que
   você queria (tela de login, erro, página vazia): confira e capture a certa.

Capturar a mesma página duas vezes, sem o conteúdo mudar e com a janela do mesmo tamanho, produz o mesmo nome de arquivo (o arquivo é sobrescrito).

### 4. Levar os arquivos para a máquina do projeto

1. Abra o projeto no VS Code Remote e, no Explorer, crie a pasta `data/corpus/logged-in/incoming/` (clique direito em
   `data/corpus/logged-in` → Nova pasta; `data/` já está no `.gitignore`).
2. No explorador de arquivos do seu computador, abra `Downloads/gp-captures/`, selecione **todos os arquivos** e
   **arraste** para `data/corpus/logged-in/incoming/` no Explorer do VS Code. (Se arrastar a pasta `gp-captures`
   inteira, ela vira `incoming/gp-captures/`; aí use esse caminho no passo seguinte.)

### 5. Importar

Na raiz do repositório, no terminal do VS Code:

```bash
node tools/corpus/src/cli.mjs import-captures data/corpus/logged-in/incoming --out data/corpus/logged-in/
```

O comando confere cada par (contrato `page-snapshot`, hash do snapshot, hash do HTML) e monta o conjunto no mesmo
layout do coletor, com o estrato `logged_in`:

```
data/corpus/logged-in/manifest.json
data/corpus/logged-in/snapshots/<hex>.json
data/corpus/logged-in/html/<hex>.html.gz
```

Saída esperada: `Importadas 12 captura(s) para data/corpus/logged-in/` e a lista de apps (o protocolo pede ≥ 10, alvo
12). O comando **só grava se todos os arquivos forem válidos**; se algo estiver errado ele lista cada problema e não
grava nada:

| Mensagem | O que fazer |
|---|---|
| `não é JSON` / `não é gzip` | Arquivo cortado ou corrompido na cópia. Capture de novo. |
| `o hash do snapshot não confere` | O `.json` foi alterado depois da captura. Capture de novo. |
| `o hash do html não confere` | O `.html.gz` não é o do `.json` (par trocado ou arquivo errado). Capture de novo. |
| `faltando o ...` | Só um dos dois arquivos do par foi copiado. Copie o outro, ou capture de novo. |
| `duplicado de ...` | O mesmo snapshot aparece com dois nomes. Apague um deles. |
| `o conjunto já tem este snapshot ... com outra captura` | Você recapturou uma página que já foi importada. Apague o arquivo novo da pasta `incoming` (ou, para trocar, apague a entrada antiga). |
| `arquivo inesperado` | Há um arquivo que não é da extensão na pasta. Tire-o de lá. |
| `esperado "logged_in"` | O arquivo não veio desta extensão. |

Pode rodar o comando de novo sobre a mesma pasta: o que já foi importado é pulado, sem alterar nada. Avisos (`aviso:`)
não bloqueiam: duas páginas do mesmo app (o protocolo pede 1 por app) e capturas com `flags`.

Terminado e conferido, **apague `Downloads/gp-captures/`** (veja o aviso de privacidade). A pasta `incoming/` pode ficar
na máquina do projeto, que é onde os dados devem estar.

## Como a extensão se limita

- **Permissões:** só `activeTab`, `scripting` e `downloads`. Sem `host_permissions`: ela só enxerga a aba em que você
  clicou, e só até você navegar ou fechar a aba.
- **Sem rede.** Nenhum `fetch`, `XMLHttpRequest`, WebSocket ou beacon no código; a CSP padrão do MV3
  (`script-src 'self'; object-src 'self'`) proíbe código remoto e `eval`, e o manifest a repete explicitamente.
- **Sem código remoto:** tudo o que roda foi gerado por `pnpm ... build` a partir deste repositório. O probe é o mesmo
  arquivo que o coletor injeta (`packages/features/dist/gp-features.iife.js`); o HTML achatado, os avisos de página
  (`pageFlags`), o `group_key` (eTLD+1) e a montagem do `PageSnapshot` são o código do coletor e de `@gran-prix/features`.
  Os testes conferem que o manifest tem exatamente essas três permissões e que nenhum script contém essas primitivas.

## Desvios em relação ao coletor (para o registro de desvios do experimento)

- **Navegador e versão:** o seu Chrome (versão completa gravada em `capture.browser.version`), não o Chromium fixado no §4.
- **Viewport:** o da sua janela (gravado em `doc.viewport_w/h`), não 1366×900.
- **Settle:** roda no seu Chrome, **depois do clique**. A janela de 0,6 s de DOM quieto (teto 8 s) é a mesma do coletor,
  mas começa no clique, não no início do carregamento (`capture.settle.tracked_from_start` fica `false`), e não há a
  espera de `networkidle` (`capture.network` = `"skipped"`).
- **URL:** sem query e sem fragmento (o coletor guarda a URL inteira; as páginas dele são públicas).
- **Status HTTP:** o da navegação, lido do Navigation Timing; se o navegador não o informar, grava 200
  (`capture.http_status_source` diz qual dos dois).
- **`capture.auth`:** o contrato só aceita `"none"`; o fato de a sessão ser autenticada está em
  `capture.authenticated_session: true` (campo extra, o contrato é aberto).
- **Só a aba principal:** iframes e shadow roots fechados não entram (igual ao coletor).

## Desenvolvimento e testes

```bash
pnpm -r build                                          # pré-requisito
pnpm --filter @gran-prix/capture-extension build       # dist/
pnpm --filter @gran-prix/capture-extension build --test-build   # também dist-test/ (nunca carregue este)
pnpm --filter @gran-prix/capture-extension test        # Chromium + extensão, precisa do Chromium do Playwright
pnpm --filter @gran-prix/corpus test                   # inclui import-captures
```

O teste com Playwright carrega a extensão com `--load-extension` e `--disable-extensions-except` no Chromium "new
headless" (`--headless=new`; o headless antigo, `chromium_headless_shell`, não suporta extensões). **O clique no ícone
não é automatizável**, e é ele que concede `activeTab`. Por isso o teste carrega `dist-test/`, cujo manifest é o de
`dist/` mais `host_permissions` para `127.0.0.1`/`localhost`, e chama a mesma função que o clique chama
(`captureTab`, exposta no service worker como `self.gpCaptureTab`; o popup também é exercitado, aberto como aba com
`?tab=<id>`). Um teste estático garante que `dist/` tem só as três permissões e que os dois builds diferem apenas por
`host_permissions`.

Os downloads são feitos por URL `data:` a partir do service worker (sem URL de objeto). Foi verificado com uma página de
18.000 nós (~7 MB de JSON). O Playwright troca o nome dos arquivos baixados por um GUID, então o teste confere o
`filename` pedido a `chrome.downloads.download` e o conteúdo gravado, não o nome em disco.

`src/shims/` troca `node:crypto` (SHA-256 síncrono em JS, testado contra `node:crypto`), `node:zlib` e `Buffer` no
bundle; a lógica reaproveitada do coletor não é copiada.
