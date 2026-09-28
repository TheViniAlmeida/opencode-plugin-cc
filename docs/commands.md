# Comandos de descoberta e configuração (F1)

Os comandos abaixo existem no terminal como `opc …` e, no Claude Code, como `/opc:…`. `--json` entrega a mesma visão estruturada; saídas não expõem credenciais. Exit 0 é sucesso, 2 é uso/valor inválido, 4 é política/chave travada e 5 é servidor inacessível.

## `/opc:setup`

Sinopse: `/opc:setup [--reconfigure]`; apoio de terminal: `opc setup [--json]`, `opc setup models`, `opc setup apply --stdin`, `opc setup commit` e `opc setup discard`.

Diagnostica dependências, oferece a instalação do OpenCode e conduz o onboarding. O rascunho pode ser retomado; `--reconfigure` inicia uma reconfiguração controlada. Use o heredoc canônico para payload JSON:

```bash
opc setup apply --stdin <<'OPC_JSON_5f1d0c7a_EOF'
{"aliases":{"rapido":"<provider-pessoal>/modelo-exemplo"}}
OPC_JSON_5f1d0c7a_EOF
```

## `/opc:config`

Sinopse: `opc config get [chave]`, `set <chave> <valor>`, `unset <chave>`, `add|remove <lista> <valor>`, `show [--effective]`, `validate`, `path` e `init`.

`--workspace` altera o `.opc.json` apenas onde ele pode restringir; `--global` seleciona a leitura global; `--tty-confirm` confirma no terminal uma chave travada. `init` exige terminal interativo. `set`, `unset`, `add` e `remove` retornam 2 para chave/valor inválido, 4 para política e 5 quando precisam de catálogo e o servidor não está acessível.

Exemplo realmente executado offline (caminhos redigidos):

```text
# opc config set

`project.goal` (global) → `<data-dir>/config.json`

Valor: `"Documentação local"`
```

E a consulta JSON correspondente:

```json
{"kind":"get","setting":"project.goal","source":"effective","value":"Documentação local"}
```

## `/opc:providers`

Sinopse: `opc providers [--all] [--json]`.

Lista providers conectados; `--all` inclui os não conectados. A coluna de política informa se cada provider é permitido. Requer servidor e retorna 5 se ele estiver inacessível.

## `/opc:models`

Sinopse: `opc models [provider] [--verbose] [--allowed] [--all] [--json]`.

Por padrão mostra modelos conectados. `--all` inclui catálogo desconectado, `--allowed` mantém apenas os permitidos e `--verbose` acrescenta detalhes. Provider desconhecido, ou não conectado sem `--all`, retorna 2; indisponibilidade do servidor retorna 5. O portão ao vivo confirmou que `--all` corresponde à listagem do OpenCode por provider.

## `/opc:agents`

Sinopse: `opc agents [--mode primary|subagent|all] [--verbose] [--allowed] [--json]`.

`--mode` filtra a modalidade, `--verbose` inclui agentes ocultos e `--allowed` aplica a política. O valor inválido de `--mode` retorna 2; servidor indisponível retorna 5. A listagem é ordenada alfabeticamente.

## `/opc:catalog`

Sinopse: `opc catalog commands|skills [--json]`.

Lista commands ou skills expostos pelo servidor. Para commands, inclui a decisão de política; para skills, nome, descrição e local. Argumento diferente de `commands` ou `skills` retorna 2; servidor inacessível retorna 5.

## Saídas e segurança

Use `--json` em integrações. O portão F1 verificou as respostas JSON de providers, modelos e onboarding e não encontrou credenciais. Evite passar segredo como argumento ou gravá-lo na configuração.

## Execução (F2a)

Todo turno roda num **worker destacado** (`opc task-worker`), registrado como job em `<estado>/jobs/<id>.json`. Em primeiro plano acompanha o job; com `--background`, devolve o id. IDs seguem `<tipo>-<base36(ms)>-<rand6>` e aceitam prefixo único.

### Códigos de saída

| Código | Quando |
| --- | --- |
| 0 | Sucesso |
| 2 | Uso inválido, id ausente/ambíguo, limite de jobs, sessão ocupada ou troca de perfil não suportada no resume |
| 3 | Job em `waiting_permission`, com pedido de permissão ou pergunta pendente |
| 4 | Negado por política, aprovador ou recursão (`OPC_INSIDE_SERVER=1`) |
| 5 | Falha de conexão/servidor |
| 6 | `--wait-timeout` ou `status --timeout-ms` expirou; o job continua e o id é impresso |
| 7 | Job terminou em `failed` |
| 130 | Job terminou em `cancelled` |

### `/opc:task`

```text
/opc:task [--write | --profile <nome>] [--model <m>] [--agent <a>] [--variant <v> | --effort <v>]
          [--tier <t>] [--resume [id] | --resume-last | --fresh] [--background]
          [--prompt-file <arquivo>] [--timeout <s>] [--wait-timeout <s>] <prompt>
```

Sem `--write`, usa `read-only`; `--write` usa `write`; `--profile <nome>` usa `custom:<nome>`. `--model` aceita alias, id completo (`provider/modelo`) ou nome curto no provider padrão. `--effort` é alias de `--variant`; `--tier` usa `routing.tiers.<tier>`. Agentes são validados contra a política; agentes apenas-subagente são recusados.

`--resume [id]` continua job ou sessão (`ses_…`); sem id equivale a `--resume-last`. `--fresh` conflita com `--resume`. `--timeout` limita o turno (padrão 1800 s); `--wait-timeout` limita só a espera (padrão 540 s). Prompt pode vir por argumento, stdin ou `--prompt-file` (bytes intactos); resume sem prompt usa `prompts/continue.md`.

Texto livre (`task`, `ask`, `plan`) usa `--raw-args-stdin`; comandos só de flags/ids usam `--args-stdin`. No heredoc, use uma linha `--` antes do texto. O corpo é preservado, flags são reconhecidas somente nas sequências inicial e final e delimitador que apareça isolado nos argumentos é recusado. Se houver `project`, inclui `<project_context>`; `OPC_INSIDE_SERVER=1` recusa job (exit 4).

```text
$ opc ask --raw-args-stdin
`src/math.js:1`

---
Tarefa: ask-mukvemmb-nvmj2z · Sessão: ses_f1948c840ffeVGPURNfoPmSNav · Modelo: omniroute-personal/opencode-go/deepseek-v4.1-flash
Continuar: /opc:ask --resume ask-mukvemmb-nvmj2z

$ opc task --background --raw-args-stdin
Tarefa opc task-mukvg8io-6ih238 na fila em segundo plano (task, omniroute-personal/opencode-go/deepseek-v4.1-flash).
- Acompanhar: /opc:status task-mukvg8io-6ih238
- Aguardar: /opc:status task-mukvg8io-6ih238 --wait
- Resultado: /opc:result task-mukvg8io-6ih238
- Cancelar: /opc:cancel task-mukvg8io-6ih238
```

### `/opc:ask` e `/opc:plan`

| Comando | Prompt | Rota | Saída esperada |
| --- | --- | --- | --- |
| `/opc:ask <pergunta>` | `prompts/ask.md` | `routing.tasks.ask` | Resposta direta com `arquivo:linha` |
| `/opc:plan <tarefa>` | `prompts/plan.md` | `routing.tasks.plan` | Goal, Files, Steps, Trade-offs, Risks, Tests, Open questions |

Aceitam flags de modelo, `--background`, `--resume`/`--fresh`, `--timeout` e `--wait-timeout`; `--write` e `--profile` retornam exit 2.

### `/opc:status`, `/opc:result` e `/opc:cancel`

```text
/opc:status [job-id] [--wait] [--timeout-ms 240000] [--poll-interval-ms 2000] [--all]
/opc:result [job-id]
/opc:cancel [job-id]
```

`status` sem id lista jobs desta sessão; `--all` inclui todas. Com id, mostra fase, modelo, sessão, filhas, erro, pedidos e log. `--wait` retorna 0 (`completed`), 3 (`waiting_permission`), 7 (`failed`), 130 (`cancelled`) ou 6 sem parar o job. `result` mostra texto final, saída estruturada, arquivos tocados e continuação; job ativo retorna 2. `cancel` aborta sessão principal e filhas, espera idle por até 10 s e encerra worker somente após conferir identidade.

### `/opc:permissions`

```text
/opc:permissions list
/opc:permissions reply <id> once|reject [mensagem] [--confirmed-by-user]
/opc:permissions answer <id-da-pergunta> <resposta...>
```

`list` mostra pedidos pendentes com job dono. `user` exige `--confirmed-by-user` em `once`; `claude` também o exige para destrutivo, `external_directory` ou caminho sensível. `reject` é sempre permitido e rejeita irmãos. `always` retorna 2; veja [Permissões](permissions.md#por-que-nunca-always).

### `opc gc`

```text
opc gc [--days 30] [--confirmed-by-user]
```

Lista estados sem uso, sem jobs ativos ou servidor vivo; o atual nunca entra. A remoção pede confirmação. Sem TTY, só remove com `--confirmed-by-user`; sem a flag, retorna 2.

```text
$ opc gc
opc gc: nada a remover; nenhum estado de workspace sem uso há mais de 30 dias.
```

### `opc task-resume-candidate --json` (interno)

Usado por `/opc:rescue` (F2b): `{available, sessionId, candidate: {id, kind, status, title, summary, sessionID, completedAt, updatedAt}}`; `--kind task|ask|plan` (padrão `task`).

## Review, gate e rescue (F2b)

### `/opc:review`

Revisa as mudanças locais com modelo do OpenCode, perfil `read-only` e saída validada no schema `review-output`. Só o usuário invoca (`disable-model-invocation`).

Uso: `/opc:review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <m>] [--variant <v>]`

- **Alvo:** `auto` revisa o working tree quando há mudanças; sem elas, revisa a branch contra `origin/HEAD`, `main`, `master` ou `trunk`. `--base` força a ref; `--scope` escolhe o modo.
- **Espera:** sem `--wait`/`--background`, mede com `opc review --estimate --json` e pergunta entre aguardar ou rodar em segundo plano. Só recomenda aguardar para até 2 arquivos e 300 linhas alteradas.
- **Diff grande:** até 400 KB vai inteiro; acima disso, envia `--stat` completo e diffs menores primeiro. O modelo pode ler os omitidos com `read`; o perfil não libera Bash.
- **Segredos:** `policy.sensitivePaths` nunca tem conteúdo enviado e aparece apenas em "Excluded Files"; symlink não rastreado não é seguido.
- **Modelo:** `--model` → `reviewModel` → `routing.tasks.review` → `defaultModel` → padrão do OpenCode.
- **Correções:** o comando somente revisa. Depois dos achados, o Claude pergunta quais corrigir antes de editar.
- **Exit codes:** 0 (qualquer veredito), 2 (uso ou fora de Git), 4 (modelo negado), 5 (servidor), 6 (espera expirou; job continua), 7 (falha, inclusive saída inválida; texto bruto impresso), 130 (cancelado).

Exemplo ao vivo redigido:

```text
$ opc review --wait
# OPC Revisão

Alvo: diff da árvore de trabalho
Modelo: omniroute-personal/cmd/deepseek/deepseek-v4-flash
Job: review-<id>

Veredito: needs-attention

O novo src/math.js contém defeitos críticos: sum lê além do array e divide ignora o divisor.

Achados:
- [critical] sum itera além do último índice e retorna NaN (src/math.js:3)
  O loop usa `i <= values.length`; a última leitura é `undefined`.
  Recomendação: Trocar a condição por `i < values.length` e cobrir com testes.
- [critical] divide retorna a / 0 e ignora o divisor b (src/math.js:12)
  A função retorna `a / 0`, descartando `b`.
  Recomendação: Retornar `a / b` e definir o caso `b === 0`.
- [high] average não trata array vazio e propaga NaN (src/math.js:7-9)
  Recomendação: Validar `values.length === 0`.

Próximos passos:
- Corrigir o limite de sum, divide e a entrada vazia de average; adicionar testes.
```

```text
$ opc review --background
# OPC Revisão

Revisão iniciada em segundo plano: review-<id>
- Progresso: /opc:status review-<id>
- Aguardar: /opc:status review-<id> --wait
- Resultado: /opc:result review-<id>
```

### `/opc:adversarial-review`

Usa o mesmo fluxo e flags de `/opc:review`, porém procura razões para não publicar a mudança: limites de confiança, perda de dados, corridas, rollback e falhas parciais. Texto após as flags vira foco literal.

```text
$ opc adversarial-review --wait foco em entradas vazias e divisão por zero
# OPC Revisão Adversarial

Alvo: diff da árvore de trabalho
Modelo: omniroute-personal/cmd/deepseek/deepseek-v4-flash
Job: review-<id>

Veredito: needs-attention

Bloquear entrega: sum retorna NaN, average não trata entrada vazia e divide ignora o divisor.

Achados:
- [critical] Off-by-one em sum faz a função retornar NaN (src/math.js:3)
- [critical] divide ignora o divisor e sempre divide por zero (src/math.js:12)
- [high] average não trata array vazio (divisão por zero) (src/math.js:8)
```

### `/opc:rescue`

Delega investigação, correção pedida ou continuação ao OpenCode pelo subagente `opc-rescue`, que chama `opc task` uma vez e devolve a saída sem comentários.

Uso: `/opc:rescue [--background|--wait] [--resume|--fresh] [--model <m>] [--variant <v>|--effort <v>] [--agent <a>] <pedido>`

- Sem `--resume`/`--fresh`, consulta `opc task-resume-candidate --json`; se houver candidata da sessão Claude, pergunta entre continuar a sessão atual (primeira opção) e começar outra.
- Por padrão roda com `--write`; peça "somente leitura" para diagnóstico sem edição.
- `--background` é repassado a `opc task`; acompanhe com `/opc:status` e leia com `/opc:result`.
- O subagente não responde permissões; o Claude principal segue o aprovador configurado.

### `/opc:setup` — stop review gate

`/opc:setup --enable-review-gate` e `/opc:setup --disable-review-gate` gravam `stopGate.enabled` somente na configuração global. Exigem onboarding já concluído; sem config global, saem com exit 2 e orientam executar `/opc:setup`.

```text
$ opc setup --enable-review-gate
# opc setup

Status: pronto

## Verificações

- node: ok (22.22.1)
- opencode: ok (1.18.32)
- diretório de dados: <tmp>
- workspace: <tmp>

## Servidor

- estado: rodando
- versão: 1.18.32
- reaproveitado: não (subiu agora)

Gate de parada: ativado (atualizado)
```

`/opc:setup --stop-server` recusa com exit 2 enquanto houver jobs ativos e os lista. `--force` exige confirmação do usuário (`--confirmed-by-user`).

### Hooks

| Hook | O que faz |
| --- | --- |
| `SessionStart` | Exporta `OPC_COMPANION_SESSION_ID`, `OPC_COMPANION_TRANSCRIPT_PATH`, `CLAUDE_PLUGIN_DATA` e `OPC_DATA_DIR`; registra a sessão e, com `delegation.auto`, injeta lembrete de delegação. |
| `SessionEnd` | Registra o fim e dispara `opc reap` destacado, saindo em menos de 1 s. |
| `Stop` | Avisa em stderr sobre jobs ativos; com o gate ligado, executa o stop review gate. |
