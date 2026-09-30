# Configuração

## Onde fica cada coisa

`opc config path` mostra os locais usados pelo processo atual. Em uma execução local com diretórios temporários, a saída (com o caminho redigido) foi:

```text
# opc config path

- Dados: `<data-dir>`
- Global: `<data-dir>/config.json`
- Workspace: `<workspace>/.opc.json`
- Rascunho do onboarding: `<data-dir>/config.draft.json`
```

A configuração global é `config.json` no diretório de dados, criada com permissão 0600. O `.opc.json` do workspace é versionável (0644) e não deve conter segredos. O rascunho retomável do onboarding é `config.draft.json`. Ao final de `/opc:setup`, o plugin imprime um alias de terminal para usar `opc` com o mesmo diretório de dados.

## Todas as chaves

| Chave | Tipo | Padrão | Escopo | Descrição |
|---|---|---|---|---|
| `defaultProvider` | string \| null | `null` | global + workspace | Completa nomes curtos de modelo |
| `defaultModel` | model \| null | `null` | global + workspace | Modelo padrão normalizado |
| `defaultVariant` | string \| null | `null` | global + workspace | Variant do modelo padrão |
| `defaultAgent` | string \| null | `null` | global + workspace | Agente padrão de sessão |
| `aliases` | model-map | `{}` | global + workspace | Apelidos para IDs completos, um nível |
| `reviewModel` | modelref \| null | `null` | global + workspace | Modelo de review |
| `review.structuredOutput` | `text` \| `tool` | `text` | global + workspace | `text`: JSON na resposta; `tool`: ferramenta de saída estruturada |
| `stopGate.enabled` | boolean | `false` | só global | Liga o stop gate (F2b) |
| `stopGate.model` | modelref \| null | `null` | global + workspace | Modelo do stop gate |
| `project.goal` | string \| null | `null` | global + workspace | Objetivo enviado no contexto do projeto |
| `project.scope` | string-list | `[]` | global + workspace | Diretórios do escopo |
| `project.taskTypes` | enum-list | `[]` | global + workspace | `ask`, `plan`, `review`, `task`, `orchestrate`, `conclave` |
| `policy.providers.allow` / `.deny` | string-list | `[]` | travada; workspace restringe | Providers permitidos/negados |
| `policy.providers.allowWorkspace` | string-list | interno | travada, só global | Interseção de allow do workspace |
| `policy.models.allow` / `.deny` | string-list | `[]` | travada; workspace restringe | Modelos permitidos/negados por glob |
| `policy.models.allowWorkspace` | string-list | interno | travada, só global | Interseção de allow do workspace |
| `policy.agents.allow` / `.deny` | string-list | `[]` | travada; workspace restringe | Agentes permitidos/negados por glob |
| `policy.agents.allowWorkspace` | string-list | interno | travada, só global | Interseção de allow do workspace |
| `policy.tools.deny` | string-list | `[]` | travada; workspace restringe | Ferramentas negadas, inclusive MCP |
| `policy.sensitivePaths` | string-list | padrões de arquivos sensíveis | travada; workspace restringe | Caminhos que o OpenCode não lê (F2a) |
| `policy.destructiveBash` | string-list | `[]` | travada; workspace restringe | Padrões destrutivos adicionais (F2a) |
| `policy.approver` | `user` \| `claude` | `user` | travada, só global | Quem aprova permissões |
| `policy.permissionTimeoutSec` | inteiro 1–86400 | `600` | travada, só global | Prazo de resposta a permissões |
| `permissionProfiles` | rules-map | `{}` | travada, só global | Perfis customizados de regras |
| `routing.tasks` / `.tiers` | modelref-list-map | `{}` | global + workspace | Modelos por tarefa ou tier |
| `routing.fallback.enabled` | boolean | `true` | global + workspace | Liga fallback (F4a) |
| `routing.fallback.maxAttempts` | inteiro 1–10 | `3` | global + workspace | Candidatos tentados |
| `routing.fallback.maxProviderRetries` | inteiro 0–20 | `3` | global + workspace | Teto de retries |
| `routing.fallback.maxRetryWaitSec` | inteiro 0–3600 | `60` | global + workspace | Espera máxima anunciada |
| `conclave.pools` | modelref-list-map | `{}` | global + workspace | Pools nomeados |
| `conclave.defaultPool` | string \| null | `null` | global + workspace | Pool padrão |
| `conclave.judge` | modelref-or-claude | `claude` | global + workspace | Juiz |
| `conclave.rounds` / `.quorum` | inteiros 1–3 / 2–16 | `1` / `2` | global + workspace | Rodadas e respostas mínimas |
| `conclave.memberTimeoutSec` | inteiro 1–86400 | `900` | global + workspace | Prazo por membro |
| `orchestrate.planner` | modelref \| null | `null` | global + workspace | Planejador |
| `orchestrate.maxSubtasks` | inteiro 2–20 | `5` | global + workspace | Máximo de subtarefas |
| `orchestrate.synthesizer` | modelref-or-claude | `claude` | global + workspace | Sintetizador |
| `orchestrate.structuredOutput` | `text` \| `tool` | `text` | global + workspace | Contrato de saída do planner |
| `delegation.auto` | boolean | `false` | só global | Lembrete de delegação (F4a) |
| `jobs.maxActive` / `.maxParallel` | inteiros 1–64 / 1–32 | `8` / `4` | só global | Limites de jobs |
| `server.bootTimeoutSec` / `.requestTimeoutSec` | inteiros 1–600 | `60` / `30` | só global | Timeouts do servidor |
| `server.configOverride` | object | `{"share":"disabled"}` | travada, só global | Conteúdo de config do servidor |

Exemplo mínimo global:

```json
{
  "defaultProvider": "<provider-pessoal>",
  "project": { "goal": "Revisar o projeto", "scope": ["src"], "taskTypes": ["review"] },
  "aliases": { "rapido": "<provider-pessoal>/modelo-exemplo" }
}
```

## IDs de modelo e aliases

Um ID completo é `provider/modelo`; o nome do modelo pode conter barras. Um nome curto é completado por `defaultProvider`. Se mais de um ID puder corresponder, o comando recusa com `AMBIGUOUS_MODEL`; use `=` para exigir o ID literal, como `=opencode/big-pickle`. Globs aceitam `*`, inclusive sobre `/`.

Aliases têm um único nível e mapeiam um nome para um ID completo. Eles podem aparecer em `reviewModel`, `routing.*`, `conclave.*` e `orchestrate.*`; um alias não pode apontar para outro alias.

## `routing`

Listas de modelos por tipo de tarefa e por tier, com política de fallback. Valores aceitam alias ou ID completo; `*` casa qualquer sequência, inclusive `/`.

| Chave | Tipo | Padrão | Significado |
|---|---|---|---|
| `routing.tasks.ask` | lista | `[]` | Candidatos de `/opc:ask`, em ordem |
| `routing.tasks.plan` | lista | `[]` | Candidatos de `/opc:plan` |
| `routing.tasks.review` | lista | `[]` | Candidatos de review quando `reviewModel` é nulo |
| `routing.tasks.task` | lista | `[]` | Candidatos de `/opc:task` |
| `routing.tiers.light` | lista | `[]` | Usada por `--tier light` |
| `routing.tiers.heavy` | lista | `[]` | Usada por `--tier heavy` |
| `routing.fallback.enabled` | booleano | `true` | Liga fallback entre candidatos de lista |
| `routing.fallback.maxAttempts` | inteiro 1–10 | `3` | Tentativas totais por turno, incluindo a primeira |
| `routing.fallback.maxProviderRetries` | inteiro 0–20 | `3` | Retries do OpenCode tolerados antes de abortar a sessão |
| `routing.fallback.maxRetryWaitSec` | inteiro 0–3600 | `60` | Espera máxima pelo próximo retry antes de abortar a sessão |

Entradas negadas pela política ou inexistentes são puladas com aviso. `--model` e níveis de valor único, como `reviewModel` e `stopGate.model`, não têm fallback. O backoff fixo entre tentativas é 2 s, 4 s e 8 s. O `.opc.json` pode definir preferências de `routing`, mas cada modelo continua sujeito à política efetiva.

Os exemplos abaixo supõem os aliases `fast`, `k3` e `strong` já definidos em `aliases` (sem eles, `config` recusa o valor com `UNKNOWN_MODEL`).

```bash
opc config set routing.tasks.ask '["fast","k3"]'
opc config add routing.tiers.heavy strong
opc config set routing.fallback.maxAttempts 2
opc config show --effective
```

## `delegation`

| Chave | Tipo | Padrão | Significado |
|---|---|---|---|
| `delegation.auto` | booleano | `false` | Com `true` na configuração global, o `SessionStart` injeta o lembrete de delegação |

O `.opc.json` só pode desligar esse lembrete com `false`; `true` no workspace é ignorado.

```bash
opc config set delegation.auto true
```

## `jobs`

| Chave | Tipo | Padrão | Significado |
|---|---|---|---|
| `jobs.maxActive` | inteiro 1–64 | `8` | Jobs ativos (`queued`, `running`, `waiting_permission`) no workspace |
| `jobs.maxParallel` | inteiro 1–32 | `4` | Turnos simultâneos dentro de grupo |

Fallback não cria jobs: as tentativas pertencem ao mesmo job, em `attempts[]`.

```bash
opc config set jobs.maxActive 4
```

## Merge restritivo do `.opc.json`

O arquivo de workspace serve para preferências permitidas e para restringir política. `deny` é unido; `allow` é intersectado por `allowWorkspace`; `sensitivePaths` e `destructiveBash` são unidos. Preferências como `defaultModel`, `project` e rotas podem ser sobrescritas no workspace. Chaves globais, travadas ou desconhecidas são ignoradas com aviso em `opc config show --effective`.

Assim, um `.opc.json` que tente ampliar `policy.models.allow` não amplia a configuração efetiva: somente a interseção vale. Nunca coloque credenciais nesse arquivo.

## Chaves travadas e bootstrap

`policy.*`, `permissionProfiles` e `server.configOverride` são travadas. Durante o bootstrap, apenas o onboarding antes da primeira config global pode gravá-las. Depois, use `opc config init` ou, em um TTY, `opc config set … --tty-confirm`. Uma edição comum cria a configuração global e encerra o bootstrap. A edição manual do arquivo não é tecnicamente bloqueada; use `opc config validate` antes de operar.

Execução local verificada, com o valor substituído pelo placeholder seguro:

```text
# opc error
LOCKED_KEY: "policy.approver" é uma chave travada; altere-a no seu terminal: opc config set policy.approver '<valor>' --tty-confirm (ou execute: opc config init)
```

## Onboarding: três portas

- `/opc:setup`: conduz instalação, provider, modelo, política, projeto e aliases; guarda rascunho, permite retomar ou recomeçar e aceita `--reconfigure`.
- `opc config init`: assistente de terminal com listas numeradas, filtro de texto, seleções `1,3,5-7` e `todos`.
- `opc config …`: interface não interativa para automação e ajustes pontuais.

Para argumentos literais no comando interno, use os delimitadores canônicos:

```bash
opc setup --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

Para JSON via stdin:

```bash
opc setup apply --stdin <<'OPC_JSON_5f1d0c7a_EOF'
{"project":{"goal":"Revisar o projeto"}}
OPC_JSON_5f1d0c7a_EOF
```

## Perfil de mundo

Um perfil de mundo pode negar um provider de trabalho, limitar modelos ao provider pessoal do operador e negar agentes de trabalho. O efeito é visível em `/opc:models --allowed` e `/opc:agents --allowed`; a escolha explícita de item negado retorna exit 4. O portão ao vivo confirmou essa aplicação de política, sem expor identificadores do ambiente.

## `opc config validate`

Valida forma, modelos, variants, aliases quebrados, agente padrão, pools, política e chaves com aparência de segredo. Quando o servidor está disponível, também valida contra seu catálogo; sem ele, retorna exit 5 e informa que a checagem remota não ocorreu. Exit 0 indica configuração válida; exit 2, erro de forma/valor; exit 4, violação de política.

Uma execução offline de forma sem servidor retornou `SERVER_DOWN`/exit 5, como esperado para a validação que depende do catálogo. O portão da fase confirmou separadamente aliases quebrados e variants inválidas.

### Saída estruturada de revisões

`review.structuredOutput` controla `/opc:review` e `/opc:adversarial-review`.
O padrão `text` pede somente um objeto JSON em uma única cerca `json`, conforme o esquema descrito no prompt, sem enviar `format` ao OpenCode. Assim, a leitura normal de mensagens continua disponível no OpenCode 1.18.32.

Use `opc config set review.structuredOutput tool` para enviar `format: json_schema` e ler as mensagens individualmente. Se os eventos SSE se perderem e a sessão estiver idle sem assistente conhecido, o runner aguarda 10 segundos e consulta novamente; se continuar assim, termina com `NO_ASSISTANT_MESSAGE`.
`opc config unset review.structuredOutput` restaura o padrão `text` quando não há uma substituição no workspace.

A extração textual aceita apenas um objeto JSON no texto completo, na última cerca `json` ou como último objeto balanceado no nível superior da prosa. Arrays e valores primitivos são rejeitados, e nenhum erro do turno é convertido em sucesso por essa extração.
O stop gate mantém seu contrato textual `ALLOW:`/`BLOCK:` e não envia `format` em nenhum dos modos. Falhas de infraestrutura permitem encerrar e incluem a causa mascarada (até 200 caracteres) em `systemMessage` e stderr.

### Orquestração

`orchestrate.planner` seleciona o modelo/alias do planner; `--planner` ou `-m` o sobrescreve.
`orchestrate.maxSubtasks` limita o plano de 2 a 20 itens e `--max` o sobrescreve.
`orchestrate.synthesizer` aceita `claude` ou um modelo e `--synthesizer` o sobrescreve.
`jobs.maxParallel` limita as subtarefas simultâneas; `jobs.maxActive` conta o grupo como um job.

`orchestrate.structuredOutput: "text"` pede um objeto JSON em uma única cerca `json`, sem
enviar `format` ao OpenCode, e extrai/valida o objeto depois. É o padrão porque, no OpenCode
1.18.32 através do gateway, o planner com `format: json_schema` retornou
`StructuredOutputError` com `Model did not produce structured output`. O comportamento é o
mesmo de `review.structuredOutput`: `tool` permanece disponível quando o ambiente suporta
saída estruturada pelo protocolo.

```bash
opc config set orchestrate.structuredOutput text
opc config set orchestrate.maxSubtasks 8
opc config set orchestrate.synthesizer omniroute-personal/cmd/<modelo>
```

## conclave

Preferências do `/opc:conclave` ([guia](conclave.md)). Podem ser sobrescritas no `.opc.json`;
todo modelo citado continua passando pela política (`policy.*`).

| Chave | Tipo | Padrão | Descrição |
|---|---|---|---|
| `conclave.pools` | objeto `{nome: [modelos]}` | `{}` | Listas de membros; aceita alias, ID completo ou nome curto |
| `conclave.defaultPool` | string ou `null` | `null` | Pool usada sem `--models` e `--pool`; sem valor, o opc procura a pool `default` |
| `conclave.judge` | `"claude"` ou modelo | `"claude"` | Juiz padrão da síntese |
| `conclave.rounds` | inteiro 1–3 | `1` | Rodadas de `opinion`; `debate` usa pelo menos 2 |
| `conclave.quorum` | inteiro ≥ 2 | `2` | Respostas válidas mínimas por rodada; não pode exceder os membros |
| `conclave.memberTimeoutSec` | inteiro | `900` | Limite de cada turno de membro ou juiz; ao expirar, aborta a sessão e descarta o membro |
| `conclave.structuredOutput` | `"text"` ou `"tool"` | `"text"` | `text` pede JSON em cerca e valida localmente; `tool` envia `format: json_schema` |

`text` é o padrão porque, no gateway usado pelo projeto, `format: json_schema` retornou
`StructuredOutputError` com `Model did not produce structured output`. Em `text`, ausência de
objeto JSON é `MissingStructuredOutput`; em `tool`, falha de formato é
`StructuredOutputError`. JSON fora do schema é `InvalidStructuredOutput` nos dois modos.

Relacionadas: `jobs.maxParallel` limita turnos simultâneos e `jobs.maxActive` conta cada
conclave como uma vaga — somente o job-grupo conta.

```bash
opc config set conclave.judge omniroute-personal/opencode-go/qwen3.8-max
opc config set conclave.memberTimeoutSec 600 --workspace
opc config set conclave.structuredOutput text
```
