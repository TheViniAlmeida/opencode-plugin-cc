# Changelog

Todas as mudanças relevantes deste projeto são registradas aqui.
O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa
[versionamento semântico](https://semver.org/lang/pt-BR/).

## [Unreleased]

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
