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
