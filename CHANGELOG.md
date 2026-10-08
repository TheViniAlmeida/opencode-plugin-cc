# Changelog

Todas as mudanças relevantes deste projeto são registradas aqui.
O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa
[versionamento semântico](https://semver.org/lang/pt-BR/).

## [Unreleased]

### Corrigido — F9

- O `.opc.json` com `{"delegation":{"auto":false}}` agora desliga o lembrete de delegação sem aviso; `true` é ignorado com o aviso `.opc.json: o workspace só pode desligar (false); ignorado` (caminho `delegation.auto`). Antes, o aviso enganoso "não pode ser substituída no workspace; ignorado" saía mesmo quando o valor valia.
- `permissions reply` e `permissions answer` limpam o pedido em todos os jobs que o espelham (membro e grupo), e a dica do `/opc:status` aponta para o membro. Antes só o primeiro achado era limpo (o grupo, se fosse o mais novo).

- `opc config set --workspace delegation.auto false` agora grava no `.opc.json` (antes recusava com `GLOBAL_ONLY_KEY`); `true` segue recusado.
- `permissions reply`/`answer` limpam primeiro os membros e depois o grupo, e um job que sumiu no meio não faz o comando falhar (a resposta já chegou ao OpenCode).
### Corrigido — F8

- O hook `SessionStart` registrava o pid do `sh -c` transitório que o Claude Code usa para rodar hooks, e não o do Claude (§15, item 9, medido ao vivo). A associação de jobs MCP à sessão nunca casava e a vida da sessão caía sempre no fallback de 24 h. Agora o hook sobe um nível quando o pai é um shell (`resolveHookOwner`).
- Os avisos do servidor (`surfaceServerWarnings`) saem no stderr da CLI como `[opc] aviso: …`, deduplicados e silenciosos dentro de hooks; o `transfer` os inclui em `warnings`. O aviso de providers sem modelos agora diz: "Providers declarados ainda sem modelos no catálogo: X. Confira credenciais e o gateway, ou se estão desligados por disabled_providers/enabled_providers (o GET /api/config do OpenCode V2 não expõe essas listas)." Nas ferramentas MCP o stderr é descartado em caso de sucesso, então o aviso não aparece lá.
- Validado ao vivo (OpenCode 2.0.22): o catálogo e o aviso em attach (`OPC_SERVER_URL`), as linhas de retomada do `transfer` num pty (a TUI abre a sessão importada, sem erro de autenticação e sem senha na linha), a precedência das fontes de config (a de `OPENCODE_CONFIG_CONTENT` vence, como no merge do opc), o `PATCH` de permissões que substitui as regras e as regras da sessão que vencem as do arquivo. A troca de um servidor V1 registrado segue N/A ao vivo (coberta por `tests/unit/server-v1-record.test.mjs`).

### Adicionado — F8

- README em inglês (`README.en.md`).
- Sondas ao vivo da F8 (attach, linhas de retomada e precedência de config), com a evidência saneada em `docs/phases/F8-live-output.md` e o relatório em `docs/phases/F8-report.md`.

### Corrigido — F7 (endurecimento V2)

- `model` e `small_model` da config do OpenCode que chegam como objeto (`{providerID, model}`) são normalizados para `provider/modelo`; a precedência das fontes (global, projeto, `OPENCODE_CONFIG_CONTENT`, a última vence) segue a documentada e continua A CONFIRMAR no servidor.
- O catálogo de modelos é considerado pronto quando os providers declarados (chave `providers` da config V2, com `provider` do V1 como reserva) carregam, nos modos gerenciado e attach; em attach a espera tem teto de 15 s com o catálogo vazio e até 2 s depois do primeiro catálogo não vazio, o aviso nomeia os faltantes e o `TIMEOUT` informa o teto e o próximo passo. NÃO VALIDADO ao vivo em attach; a forma V2 de `enabled_providers` e `disabled_providers` segue A CONFIRMAR.
- Um servidor gerenciado registrado pelo opc que responde como anterior à 2.0.22 é substituído em vez de falhar com `NOT_JSON`; com jobs ativos nele, o erro é `V1_SERVER_ACTIVE`. NÃO VALIDADO ao vivo (sem servidor antigo real).
- As páginas seguintes de `children` enviam só `cursor` e `limit` (o cursor já mantém o filtro de `parentID`).
- O runner confirma a interrupção pela ociosidade da sessão, não pela flag `interrupted`.
- `session show` mostra as mensagens mais recentes; `session fork` reaplica e verifica as regras de permissão e o modelo da origem, que o OpenCode 2.0.22 não carrega para o fork, e falha com `FORK_INHERITANCE_FAILED` (sem apagar o fork) quando não consegue.
- `session summarize` espera a compactação dentro de um único `--timeout` e, no prazo estourado, falha com `TIMEOUT` (exit 5) informando que a compactação continua no servidor.
- `task --resume` e `summarize` avisam quando a sessão tem revert pendente (um prompt novo o consolida), e a prévia do `revert` avisa quando o estado dos snapshots é desconhecido.
- Se o segredo de attach não puder ser gravado depois da importação, o `transfer` devolve o ID da sessão com um aviso para usar `/opc:attach`, em vez de falhar e levar a uma segunda importação.
- A linha de retomada do `transfer` usa o binário configurado e lê a senha fora do argv (`"$(cat '<stateDir>/attach.secret')"` no servidor gerenciado, `"$OPC_SERVER_PASSWORD"` em attach).
- Removidos os ramos de `StructuredOutputError` e `planner_structured_output` herdados do OpenCode 1.

### Alterado — F6 (OpenCode V2)

- OpenCode ≥ 2.0.22 é obrigatório; a API V1 não é suportada. O binário pode ser escolhido por `server.opencodeBin` ou `OPC_OPENCODE_BIN`.
- `session todo` e a ferramenta MCP `opc_session_todo` foram removidos porque o V2 não oferece tarefas de sessão.
- `/opc:attach` abre `opencode --server <url> -s <sessionID>` com a senha em `OPENCODE_SERVER_PASSWORD`.
- `structuredOutput: tool` não produz saída estruturada no V2; o opc usa `text` e valida o JSON localmente.
- O `PATCH` de permissões substitui a lista; a troca de perfil no `--resume` é permitida.
- Catálogos omitem `settings`, que pode conter chave de provider.
- O modelo padrão do servidor (`/api/model/default`, em geral gratuito do provider `opencode`) não é mais fallback de execução; sem `--model`, rota, `defaultModel` ou `model` declarado na configuração do OpenCode, o erro é `NO_MODEL`.
- O boot do servidor gerenciado espera o evento `model.updated` (até 30 s) antes de resolver modelos, porque o V2 carrega providers do gateway depois do boot.
- `/opc:setup` não oferece mais `npm install -g opencode-ai` (o pacote npm ainda publica o V1); orienta a instalação oficial do 2.0.22+ ou `server.opencodeBin`.
- `session fork` usa `--before <messageID>`; `revert --part` e `diff --message` deixaram de existir.
- No conclave, JSON inválido no texto falha como `InvalidStructuredOutput` (com o caminho do erro); prosa sem JSON continua `MissingStructuredOutput`.
- `session revert` aplica só o stage do V2: os arquivos voltam e o revert fica pendente até `unrevert` (o commit, que apaga as mensagens sem volta, não é chamado). Com `"snapshot": false` na config do OpenCode, recusa com `SNAPSHOT_DISABLED`, e `session diff` avisa que o diff fica vazio.
- Leitura de mensagens e sessões paginada por cursor (no máximo 200 por página, como exige o V2); `session summarize` envia o corpo `{}` exigido por `/compact`.

### Adicionado — F5 (MCP e transfer)

- Servidor MCP stdio `opc`, sem dependências, com 25 ferramentas `opc_*` que usam o mesmo despachante da CLI. Negociação das versões `2025-06-18`, `2025-03-26` e `2024-11-05`; jobs longos em background por padrão e espera limitada a 540 s.
- `/opc:transfer` e `opc transfer`: conversão do histórico JSONL do Claude Code para o formato de `opencode export`, importação por `opencode import` e comando para retomar a sessão no terminal.
- Testes de aceite da F5 para MCP e transferência, habilitados apenas com `OPC_LIVE=1` e modelos explícitos. O round trip de transferência usa histórico sintético e armazenamento OpenCode isolado.

### Corrigido — argumentos e histórico da F5

- Flags de leitura de stdin depois de `--` permanecem texto literal no despachante e nas ferramentas MCP.
- Requisições MCP concorrentes permitem responder a `ping` enquanto outra chamada aguarda um job.
- O processo MCP drena as respostas JSON-RPC antes de sair no EOF e retorna falha em erros de transporte, preservando os frames sob backpressure.
- O teste de GC restaura as permissões dos diretórios antes de sua limpeza, evitando `EACCES` em Node 24.
- Mensagens de usuário com resultados de ferramentas misturados a texto, imagem ou documento preservam o prompt e os anexos no turno correto.

### Segurança — F5

- O MCP preserva as confirmações e o aprovador dos comandos. Escrita de configuração, revert/unrevert, parada do servidor, review e transfer continuam fora do catálogo MCP.
- A transferência valida a raiz real do transcript, impede troca por symlink durante a abertura e limita os bytes efetivamente lidos. O export temporário é privado (arquivo 600, diretório 700) e removido após a tentativa de importação.
- Erros de transferência omitem caminhos pessoais e saída bruta de subprocessos; processos com erro não são aceitos como sucesso mesmo quando imprimem um marcador de importação.

### Corrigido — suíte de testes sempre termina

- `scripts/run-tests.mjs` não fica mais pendurado quando um teste trava (por exemplo, no sandbox do Codex, onde `listen 127.0.0.1` dá `EPERM`). O runner passa `--test-timeout` (300 s por arquivo, fora do live) e `--test-force-exit`, e roda a suíte num grupo de processos próprio. Esse grupo é encerrado inteiro no timeout da execução (30 min; 6 h no live), em `SIGINT`/`SIGTERM`/`SIGHUP` (código 128 + sinal) e quando o processo pai morre. Os limites podem ser ajustados com `OPC_TEST_TIMEOUT_MS` e `OPC_TEST_RUN_TIMEOUT_MS`.
- O sleeper dos testes (`spawnSleeper`, `ORPHAN_SAFE_IDLE` em `tests/helpers.mjs`) não segura mais o processo do arquivo e sai sozinho quando fica órfão. Antes, um `t.after` que lançava erro fazia o node:test pular o hook que o matava.

### Corrigido — runner de testes não perde resultados

- `scripts/run-tests.mjs` deixou de passar `--test-force-exit`: com ele, o Node 22/24 às vezes encerrava o processo do arquivo antes de entregar todos os resultados ao runner (por exemplo, `tests/unit/policy-profiles.test.mjs` reportava 43, 46 ou 63 casos com exit 0). O runner agora usa `--import` com `scripts/test-exit-after-grace.mjs` (Node ≥ 20.6), que 3 s depois do fim dos testes do arquivo chama `process.exit()` somente se algum handle vazado ainda prende o processo. Todos os resultados são entregues e uma falha continua dando exit 1. A entrada anterior sobre `--test-force-exit` é histórica.

### Adicionado — F4c (conclave)

- `/opc:conclave` e `opc conclave`: consulta paralela a N ≥ 2 modelos nos modos `opinion`, `debate` (2–3 rodadas anônimas na mesma sessão de cada membro) e `review` (review cruzado do diff com agrupamento de achados e concordância `k/N`).
- Composição com política por membro, rótulos aleatórios, quorum por rodada e descarte de membros com timeout, `StructuredOutputError` ou saída fora do schema.
- Anonimização de nomes de modelo, vendor e provider antes do debate e do juiz, inclusive em caminhos citados; do catálogo só entram identificadores específicos, então a prosa comum passa intacta mesmo com catálogos grandes.
- `conclave.structuredOutput` (`text` padrão | `tool`); respostas com os valores no formato do schema (`properties`, `title`, `$schema`) são aceitas quando validam.
- Falhas de persistência do coordenador terminam o grupo com `coordinator_error`.
- Síntese por juiz modelo (schema `conclave-synthesis`, `--allow-judge-member`) ou pelo Claude com a skill `opc-conclave`.
- Schemas `conclave-member` e `conclave-synthesis`; prompts `conclave-member.md`, `conclave-debate.md` e `conclave-judge.md`.
- Documentação: `docs/conclave.md`, seção do conclave em `docs/commands.md`, `docs/configuration.md`, arquitetura e troubleshooting.

### Adicionado — F4b (orquestração)

- F4b — Orquestração: `/opc:orchestrate` e `opc orchestrate` (decomposição por planner,
  validação do plano com detecção de ciclos, leituras paralelas, escritas em série, rota por
  tier/tipo com espalhamento de modelos, injeção de dependências e síntese pelo Claude ou por
  modelo).
- Schema `orchestrate-plan` e prompts `orchestrate-decompose`/`orchestrate-synthesize`.
- Seção "Orquestração" na skill `opc-delegation`, em `docs/swarm.md`, `docs/commands.md`,
  configuração, troubleshooting, arquitetura e relatório de fase.

### Adicionado — F4a (roteamento, fallback, delegação, worker, monitor)

- Fallback de modelo para rotas em lista (`routing.tasks.<tipo>` e `--tier light|heavy`): nova sessão por tentativa, backoff de 2/4/8 s, até `routing.fallback.maxAttempts`; cada tentativa registrada em `attempts[]` do job e exibida em `opc result`.
- Teto de retries do OpenCode: a sessão é abortada quando o retry passa de `maxProviderRetries` ou agenda além de `maxRetryWaitSec`, e o erro é tratado como recuperável (`RetryCapExceeded`).
- Sem fallback para `--model` explícito, níveis de valor único, `--resume`, erros fatais, queda do servidor, cancelamento e turnos `--write` que já executaram ferramentas (a falha lista arquivos tocados e ferramentas).
- Entradas negadas pela política ou inexistentes nas listas de rota são puladas com aviso; `--tier` inválido ou vazio é erro de uso.
- Skill `opc-delegation` e lembrete de delegação no `SessionStart` com `delegation.auto` (só pela config global; o `.opc.json` só desliga).
- Agente `opc-worker` para Agent Teams (regras inline, um comando `opc` por tarefa, protocolo `⚡`/`✓`/`⏸`/`✗`, nunca responde permissões, sem ferramenta Agent).
- `opc monitor` no terminal: acompanhamento ao vivo dos jobs (fase, modelo, tentativa, pedidos pendentes, log), com `--job`, `--once`, `--json`, `--color` e `--interval`.

### Adicionado (F3 — sessões, subagentes, commands, attach)

- `/opc:sessions` e `/opc:session`: criação, consulta, fork, revert/unrevert com confirmação, resumo, filhas, diff e tarefas.
- `/opc:subagent`: grupo de jobs com membros concorrentes, sessão filha por membro e fallback para `subtask`; `status`, `result` e `cancel` agregados.
- `/opc:command`: executa commands do OpenCode em job próprio com política aplicada ao modelo e agente.
- `/opc:attach` e `--pane` no tmux, com segredo lido de `<stateDir>/attach.secret` somente dentro do pane.

### Alterado

- `jobs.maxActive` e a poda contam o grupo como um job; membros não são barrados por esse limite e `cancel` sem id os ignora.
- Membros isolados não viram `worker_lost`; um grupo perdido encerra seus membros ativos.
- O servidor gerenciado publica e remove `attach.secret` durante o próprio ciclo de vida.

### Adicionado (F2b — paridade Codex)

- `/opc:review` e `/opc:adversarial-review`: estimativa, pergunta aguardar/background, schema `review-output`, modo em partes acima de 400 KB e render por severidade.
- Stop review gate no hook `Stop` e `/opc:setup --enable-review-gate|--disable-review-gate`.
- `/opc:rescue`, subagente `opc-rescue`, hooks `SessionStart`, `SessionEnd` e `Stop`.
- Skills `opc-runtime`, `opc-result-handling` e `opc-prompting`.

### Alterado

- Jobs de `task`, `ask` e `plan` são registrados sob `server.lock`, fechando a corrida com o reaper.
- `/opc:setup --stop-server` recusa enquanto houver jobs ativos e os lista.

### Segurança

- Coleta de diff não envia conteúdo de `policy.sensitivePaths` nem segue symlinks não rastreados.

### Adicionado (F2a — núcleo de execução)

- `/opc:task`, `/opc:ask` e `/opc:plan`: workers destacados, resolução de modelo, `--effort`, `--resume`/`--resume-last`/`--fresh`, `--background`, timeouts, prompt por argumento/arquivo/stdin e `<project_context>`.
- Perfis `read-only`, `write` e `custom:<nome>`, ponte de permissões/perguntas, `/opc:permissions`, jobs (`status`, `result`, `cancel`), `opc gc` e `opc task-resume-candidate --json`.
- Prompts `ask.md`, `plan.md` e `continue.md`, classificação de erros, retries limitados e tratamento de perda do servidor durante o turno.
- Documentação de execução e permissões.

### Segurança

- Invariantes para diretório externo, caminhos sensíveis, agentes/ferramentas negados, comandos destrutivos e `doom_loop`, aplicadas também às sessões filhas.
- `always` nunca é enviado; comandos destrutivos encapsulados ou não analisáveis exigem confirmação do usuário.
- Registros persistidos são redigidos; a entrada bruta do job é privada, consumida atomicamente e descartada ao terminar.

### Adicionado (F1 — descoberta, configuração e onboarding)

- `/opc:providers`, `/opc:models`, `/opc:agents` e `/opc:catalog`, com a política do opc aplicada (`--allowed`, `--all`, `--verbose`, `--mode`).
- `/opc:config` (`get`, `set`, `unset`, `add`, `remove`, `show --effective`, `validate`, `path`) e o assistente de terminal `opc config init`.
- Onboarding guiado no `/opc:setup` (instalação do OpenCode, provider, modelos, política, projeto e aliases) com rascunho retomável e commit atômico validado contra o servidor.
- Esquema completo da configuração, merge restritivo do `.opc.json`, chaves travadas (`policy.*`, `permissionProfiles`, `server.configOverride`) e aviso de chaves com aparência de segredo.
- Normalização de IDs de modelo (nome curto, ambiguidade, prefixo `=`), aliases, validação de variants e checagem de modelos fixados por agentes e commands.

## [0.1.0] - 2026-09-26

F0 — fundação e conexão.

### Adicionado

- Marketplace `opencode-plugin-cc` e plugin `opc`, com executável `bin/opc`.
- CLI `opc` com checagem de Node ≥ 20, `--args-stdin`, `--cwd`, `--json` e exit codes.
- `/opc:setup`: diagnóstico e ciclo de vida do `opencode serve` por workspace, inclusive `--stop-server [--force]` com confirmação.
- Núcleo de redação, locks verificáveis, estado privado, merge restritivo de configuração, HTTP e SSE.
- Testes unitários, integração com OpenCode falso, testes ao vivo, contrato de formas e scanner de segredos.
- Documentação de instalação, arquitetura, solução de problemas e relatório da F0.
