# Avaliação — suporte do opc ao OpenCode V2

**Data:** 06/10/2026 · **Alvo:** OpenCode 2.0.22 · **Base atual do plugin:** OpenCode 1.18.x (V1), plugin 0.1.0

## Resumo

O V2 não é uma atualização compatível: reformula a API HTTP, os eventos, o formato das mensagens, o schema
de permissões, o export/import e o CLI. Todo comando do opc que fala com o servidor é afetado. O suporte
cabe numa fase própria (F6) que troca a camada de integração (`lib/http.mjs`, `lib/api.mjs`, `lib/sse.mjs`,
`lib/server.mjs`, `lib/runner.mjs`, `lib/session-messages.mjs`, `lib/policy.mjs`, `lib/transfer.mjs`) e o
servidor falso dos testes. As regras de produto (política, jobs, roteamento, orquestração, conclave, MCP,
hooks) ficam; o que muda é como elas chegam ao OpenCode.

Recomendação: **migrar para V2 apenas** (mínimo 2.0.22), sem manter V1, numa branch `feat/opc-f6-opencode-v2`.

## Como a avaliação foi feita

- Inventário de tudo que o plugin consome do OpenCode (endpoints, campos, eventos, CLI, config, formatos).
- Sondagem do `opencode` 2.0.22 num servidor isolado (HOME e XDG temporários, porta própria): OpenAPI
  (`/openapi.json`, 116 rotas sob `/api/*`), autenticação, sessões, prompt, eventos SSE, permissões, forms,
  config inline, catálogos, export/import.
- Não validado: fim de turno com inferência real e provider configurado, pedido de permissão disparado por
  tool do modelo, eventos `session.execution.succeeded|failed` e `session.text.*` (vistos só como strings
  do binário).

## Estado da máquina do operador (06/10/2026)

- `~/.opencode/bin/opencode` é o V2 2.0.22; os serves do operador já rodam V2.
- No `PATH`, o primeiro `opencode` é o V1 1.18.34 (instalação via bun); hoje o opc sobe esse V1.
- A config global do OpenCode usa permissões V2; o V1 a rejeita. Enquanto o plugin depender do V1, os
  testes ao vivo não rodam com a config do operador.
- O V2 usa os mesmos diretórios de dados do V1 (`~/.local/share/opencode/opencode.db`) e expõe
  `/api/experimental/migration/v1`; o efeito de migração sobre dados V1 não foi testado fora do isolamento.

## Matriz V1 → V2

| Área | V1 (hoje) | V2 (2.0.22) | Impacto |
|---|---|---|---|
| Rotas | `/session`, `/event`, `/config`… | Prefixo `/api/*`; rotas sem prefixo devolvem a SPA (HTML 200, sem auth) | Toda chamada muda; risco de falso positivo |
| Health/versão | `GET /global/health` `{healthy,version}` | `GET /api/info` `{version,pid,urls,paths}` | Novo health; exigir JSON |
| Auth | Basic `opencode:<senha>` (`OPENCODE_SERVER_PASSWORD`) | Igual; usuário fixo `opencode`; sem senha o servidor gera e imprime uma | Compatível; sempre passar senha |
| Workspace | Query `?directory=` | Header `x-opencode-directory` ou query `location[directory]`; sessão tem `location` | Ajuste no cliente |
| Servidor | `opencode serve --port --hostname`; log `opencode server listening on …` | `opencode serve --hostname --port` (oculto no help); log `server listening on …`; SIGTERM limpo | Ajustar regex de pronto e matcher do processo |
| Criar sessão | `POST /session {title,permission[],parentID,agent,model}` | `POST /api/session {title,parentID,agent,model{id,providerID,variant},location,permissions[]}` → `{data}` | Mapeamento direto |
| Prompt | `POST /session/{id}/prompt_async {messageID,model,agent,variant,parts[],format}` | `POST /api/session/{id}/prompt {text,files[],agents[],skills[],delivery,resume}`; modelo/agente na sessão ou via `/model` e `/agent` | Modelo e agente passam a ser estado da sessão; sem `parts` de subtask |
| Saída estruturada | `format: {type:'json_schema'}` + tool `StructuredOutput` | **Não existe** | review/conclave/orchestrate: JSON no texto + validação local |
| Abort | `POST /session/{id}/abort` → bool | `POST /api/session/{id}/interrupt` → `{interrupted}` | Mapeamento direto |
| Status | `GET /session/status` (idle/busy/retry) | `GET /api/session/active` (`running`; ociosa ausente) | Mapeamento; retry via evento |
| Mensagens | `{info, parts[]}`; tipos de part text/tool/reasoning/step | Lista plana por `type` (`user`, `assistant` com `content[]`, `shell`, `synthetic`, `idle{outcome}`…) | Reescrever leitura de turno e agregação |
| Fim de turno | assistant com `parentID===messageID` e `time.completed` | Mensagem `idle` com `outcome: succeeded|failed|interrupted` + eventos `session.execution.*` | Reescrever detecção |
| Eventos SSE | `/event`; `message.part.updated`, `session.idle`, `session.status`… | `/api/event` (todas as locations); envelope `{id,type,location,data,durable}`; heartbeat em comentário `: heartbeat` a cada 15 s; `session.step.*`, `session.tool.*`, `session.execution.*`, `session.usage.*` | Reescrever o hub e o roteamento |
| Permissão (regras) | `{permission, pattern, action}`; nomes `bash`, `task`, `list`, `todowrite`, `doom_loop`… | `{action, resource, effect}`; nomes `shell`, `subagent`, `question`, `browser`, `edit`, `read`, `grep`, `glob`, `webfetch`, `external_directory`… | Remapear perfis e invariantes; conferir cada nome |
| Permissão (pedido) | `GET /permission`, `POST /permission/{id}/reply {reply: once|reject}` | Por sessão: `GET /api/session/{id}/permission`, `POST …/permission/{req}/reply {decision: once|always|reject}`; `always` grava regra salva por projeto | Ajustar ponte; manter `always` proibido |
| Perguntas | `question.*`, `POST /question/{id}/reply {answers}` | `form.*` com campos tipados; `POST …/form/{id}/reply {answer:{key:valor}}` | Nova ponte de forms |
| Filhas | `GET /session/{id}/children` | `GET /api/session?parentID=<id>` | Mapeamento direto |
| Fork | `POST /fork {messageID}` | `POST /api/session/{id}/fork {before?}`; resultado sem `parentID`, com `fork{sessionID,boundary}` | Ajustar |
| Revert | `revert` / `unrevert` | `revert/stage`, `revert/commit`, `DELETE revert` | Redesenhar `session revert` |
| Summarize | `POST /summarize` | `POST /compact` | Mapeamento |
| Todo | `GET /session/{id}/todo` | **Não existe** | `session todo` sai ou vira NÃO SUPORTADO |
| Comandos | `POST /session/{id}/command` → `{info,parts}` | `POST /api/session/{id}/command` → 204 (resultado por eventos/mensagens) | Ajustar |
| Catálogos | `/provider` (com modelos), `/agent`, `/command`, `/skill` | `/api/provider`, `/api/model`, `/api/model/default`, `/api/agent` (`permissions[]`), `/api/command`, `/api/skill` | Ajustar formatos |
| Config | `GET /config` mesclado; `OPENCODE_CONFIG_CONTENT` | `GET /api/config` devolve lista de fontes; `OPENCODE_CONFIG_CONTENT` ainda vale | World check (`share`) precisa de nova leitura |
| Dispose | `POST /instance/dispose` | Sem equivalente direto confirmado | `sessions --refresh` A CONFIRMAR |
| Export/import | `opencode import <arquivo>` (formato V1) | `opencode session import [--directory]` / `POST /api/experimental/session/import`; formato V2 (`info` com `cost`, `tokens`, `time`, `location`; mensagens planas); id preservado | Reescrever o transfer |
| Retomar/attach | `opencode -s <id>`, `opencode attach <url> -s <id>` | `opencode -s <id>`; TUI conecta via `--server <url>`; sem subcomando `attach` | Ajustar `/opc:attach` e o texto do transfer |
| Modelo no CLI | `provider/model` | `provider/model#variant` | Ajustar mensagens |

## Riscos

1. **Execução sem permissão por padrão.** O agente `build` do V2 vem com `*: allow`; uma sessão criada sem
   `permissions` explícitas executa `shell` sem perguntar. O opc já cria toda sessão com regras próprias;
   no V2 isso passa a ser obrigatório em toda criação e precisa de teste que prove.
2. **Modelo implícito.** Sem modelo na sessão, o V2 usa o default do catálogo (inclui modelos gratuitos do
   provider `opencode`) sem erro. O opc deve sempre fixar modelo e agente na sessão antes do prompt, e a
   política de providers deve negar o provider `opencode` quando não estiver liberado.
3. **Falso positivo de health.** Rotas V1 respondem HTML 200 no V2; health, catálogos e attach devem exigir
   JSON e o prefixo `/api`.
4. **Saída estruturada.** Sem `json_schema` no servidor, review/conclave/orchestrate dependem do texto do
   modelo; a validação local (já existente no parse de review) vira o único caminho.
5. **API experimental.** `wait`, `export`, `import` e `migration` estão sob `/api/experimental`; o OpenAPI se
   descreve como "experimental". Fixar versão mínima e registrar as formas num contrato (como o
   `contract/opencode-1.18.32.shapes.json` atual) para detectar quebra.
6. **Testes.** A maior parte da suíte usa o servidor falso V1 (`tests/fixtures/fake-opencode.mjs`,
   `fake-session-api.mjs`, `f3-fake.mjs`, cenários). Ele precisa ser reescrito para V2, com os cenários.

## Estratégia recomendada

**V2 apenas.** O plugin está em 0.1.0, sem usuários externos, e o operador já roda V2. Manter V1 e V2 dobraria
o servidor falso, os cenários e os testes de contrato sem benefício. A versão mínima passa a 2.0.22; o setup
detecta V1 e orienta a atualização.

Alternativa descartada: adaptador duplo V1/V2. Só faria sentido com usuários presos ao V1.

## Fase F6 proposta (esboço)

1. Contrato V2: capturar formas reais (OpenAPI + respostas) em `tests/fixtures/contract/opencode-2.0.22.shapes.json`.
2. Servidor falso V2 (rotas `/api/*`, SSE com envelope e heartbeat em comentário, mensagens planas, permissões e forms por sessão) e migração dos cenários.
3. Cliente HTTP/API: prefixo, `x-opencode-directory`, health via `/api/info` com JSON obrigatório, versão mínima 2.0.22.
4. Ciclo de vida do servidor: `opencode serve`, linha de pronto V2, matcher de processo, senha sempre explícita.
5. Hub SSE V2: envelope, heartbeat, roteamento por `sessionID` e filhas via `parentID`.
6. Motor de turno: modelo/agente na sessão, prompt V2, fim por `idle.outcome`, agregação de `content[]`, uso/custo, erros e retry.
7. Política: mapear perfis e invariantes para `{action,resource,effect}` e os nomes V2; ponte de permissões por sessão; ponte de forms; prova de que nenhuma sessão nasce sem regras.
8. Saída estruturada por texto + validação (review, conclave, orchestrate).
9. Comandos de sessão e catálogos (children, fork, revert stage/commit, compact, diff; `todo` removido; providers/models/agents/commands).
10. Transfer V2 (export no formato V2, `opencode session import --directory`, id preservado) e attach/retomada.
11. Docs, contrato ao vivo e portão com dois modelos (`OPC_LIVE_MODEL`, `OPC_LIVE_MODEL_2`).

## Decisões para o operador

1. V2 apenas (recomendado) ou manter V1 em paralelo.
2. `session todo`: remover (recomendado) ou manter como NÃO SUPORTADO no V2.
3. `/opc:attach`: passar a imprimir/abrir `opencode --server <url> -s <id>` (recomendado).
