# Permissões

O opc não altera a configuração global do OpenCode. Cada sessão criada recebe um perfil de regras
`{action, resource, effect}`. A última regra que casa vence; regras da sessão vencem as do
agente e da configuração global.

## Perfis

### `read-only` (padrão)

Usado por `task` sem `--write`, `ask` e `plan`. Começa com `* * deny`, libera `read`, `glob`,
`skill` e `question`, e então acrescenta as invariantes. `grep` permanece
negado: padrões de grep podem ser termos de busca, e não caminhos, impedindo a proteção segura
dos caminhos sensíveis. Não há `shell`, `edit`, `subagent`, `webfetch` nem `websearch`.
Pedidos residuais são rejeitados pela ponte.

### `write` (`--write`)

Herda o agente `build` e as regras do usuário; o opc acrescenta invariantes, inclusive
`shell <padrão> ask` para a lista destrutiva e `browser * deny`.

### `custom:<nome>` (`--profile <nome>`)

É `read-only` mais as regras de `permissionProfiles.<nome>` da configuração global (chave
travada) e as invariantes. Se liberar shell, a lista destrutiva também é anexada como `ask`.
Não existe perfil ou flag que libere tudo.

## Ordem final das regras e invariantes

A composição é: **perfil → `extraAllow` do chamador → invariantes**. `extraAllow` permite,
por exemplo, que o carrier do subagente peça uma ferramenta, mas fica antes de todas as
negações. As invariantes seguem esta ordem:

1. `external_directory * deny`;
2. `grep * deny` nos perfis `read-only` e `custom`;
3. `shell <destrutivo> ask` em `write` e `custom` com shell;
4. `read/grep/glob <sensível> deny` para cada `policy.sensitivePaths`;
5. `subagent <agente negado> deny`;
6. `<policy.tools.deny> * deny`;
7. `browser * deny`.

Assim, negar `shell` explicitamente vence também o `ask` destrutivo. O agente implícito
`build` passa pela mesma política que um agente explícito, inclusive em review, gate,
conclave e orquestração. O carrier `subagent-tool` negado pela política de ferramenta ou
agente falha com `SUBAGENT_DENIED` antes de criar sessão, sem fallback silencioso para
`child-session`; o operador precisa escolher esse mecanismo explicitamente.

Os globs usam `*` inclusive para `/`; `**/` aceita zero diretórios, cobrindo `id_rsa` na
raiz. Os padrões completos estão em [Configuração](configuration.md#caminhos-sensíveis-padrão).

## Comandos destrutivos

A lista embutida cobre remoção recursiva, força no Git, Docker, `kubectl delete`, formatação ou
sobrescrita de disco, `find -delete`, desligamento e SQL `DROP`/`TRUNCATE`.
`policy.destructiveBash` só acrescenta padrões. Pedidos destrutivos vão sempre ao usuário,
independentemente do aprovador.

A análise inspeciona **todos** os recursos shell: `metadata.command` e cada string de
`patterns`. Inclui git normalizado (opções globais, ordem dos argumentos, flags agrupadas e
abreviações), wrappers e segmentos compostos. Comando impossível de analisar, sintaxe
ambígua, here-doc, expansão em posição de comando ou fonte externa detectada exige o usuário
(falha fechada). Pode gerar falso positivo benigno, como argumento contendo `TRUNCATE`.

### Categorias e limites do classificador (`approver=claude`)

É uma lista de negação de melhor esforço; **não é fronteira de segurança**. O classificador
não executa nem expande o shell. Expansões dinâmicas, `$(…)`, aliases, funções, `source` e
here-docs falham fechado onde detectáveis. Protege contra erro do agente, sem garantia contra
adversário. Aliases do `~/.gitconfig` e do shell não são visíveis.

O endurecimento da Tarefa 2 se organiza por categorias: git normalizado, env de execução,
allowlist de `set`/`shopt`/opções de shell e `eval`/`source`/`trap` em falha fechada.
**Neste checkout, as rodadas 2–5 ainda aguardam integração**: env de execução, allowlists,
cache e a cobertura adicional de shells não estão garantidos. O [relatório F11](phases/F11-report.md)
separa testes locais de resultados do worktree; esta descrição não é uma lista exaustiva.

Limites consolidados das re-revisões 1–4 (alguns são alvo da rodada 5 pendente):

- Caminhos fora de `sensitivePaths`, como `.gnupg`, não são cobertos pelos defaults; amplie a
  política. `.env.example` continua sensível por `*.env.*`.
- `export LD_PRELOAD`/`export PATH` sem valor reexportam variáveis existentes sem exigir o
  usuário. `--output-directory`/`-o` de `git format-patch` e outras opções git que gravam
  arquivo fora de `--output` também são limites; o bloqueio geral de `--output` aguarda integração.
- Nameref (`declare -n`), `trap`, `enable`, funções/alias, `time`/`eval` envolvendo `set` e
  shells fora de `SHELLS` (`ash`, `rbash`, `mksh`, `hush`, `fish`, `busybox ash`) têm lacunas.
  A rodada 5 busca fechar nameref, `trap`/`source`/`eval`, `time`+`set` com git e ampliar shells;
  a cobertura final precisa da integração e revisão.
- No endurecimento por allowlist, opções longas de shell (`--norc`, `--noprofile`, `--posix`,
  `--login`) exigem o usuário quando há git/destrutivo. Isso não é garantido no checkout atual.
- O cache de globs LRU de 4096 entradas da rodada 4 perde ganho de desempenho com mais de
  4096 padrões distintos, mantendo a correção. O ledger mediu 600 padrões × 2000 palavras
  em torno de 0,3 a 0,9 s; esse benchmark não foi executado neste checkout, ainda sem cache.
- O endurecimento exige o usuário para nomes `GIT_*`, exceto `GIT_TERMINAL_PROMPT`/`GIT_TRACE*`
  (ruído conhecido: `GIT_AUTHOR_NAME=x git commit`). Essa proteção aguarda integração.
  `set -a` sem git/destrutivo no comando e variáveis que um comando não-git repassa a um git
  filho continuam fora dessa garantia.

As regras de sessão do servidor casam por **prefixo**: não fazem a normalização de shell
usada por `requiresUser`/`checkReply`. O classificador atua quando chega um pedido à ponte;
um comando liberado sem pedido não passa por ele. Para garantia forte use `approver=user`
(padrão), ou `policy.destructiveBash`/profile restritivo adequado ao projeto.
`approver=claude` é conveniência.

## Sessões filhas

No V2, a ferramenta `subagent` cria a filha com `parentID`; ela herda as `permissions` e o modelo da sessão pai. O opc acompanha a filha e confirma as regras aplicadas.

## Ponte de pedidos e aprovador

Em `read-only`, pedidos são rejeitados imediatamente. Em `write`/`custom`, o job entra em
`waiting_permission`; em primeiro plano retorna 3 e o worker espera `policy.permissionTimeoutSec`
(padrão 600 s), quando rejeita sem aprovador. Rejeitar um pedido rejeita os irmãos pendentes.

| Aprovador | `reply once` | `reply reject` |
| --- | --- | --- |
| `user` (padrão) | Exige `--confirmed-by-user` | Livre |
| `claude` | Exige usuário para destrutivo, `external_directory`, caminho sensível (inclusive argumento de `shell`), `webfetch`, `websearch` e qualquer permissão desconhecida | Livre |

Permissões conhecidas sem exigência adicional são `read`, `glob`, `grep`, `list`, `edit`,
`skill`, `question`, `todowrite`, `task` e `shell` não destrutivo, fora de caminhos sensíveis.
Um recurso shell ausente também exige o usuário.

`confirmedByUser` no MCP é declarativo: o processo não prova que um humano confirmou.
O portão real é o prompt de permissão do Claude Code para a ferramenta (`destructiveHint`).
Nunca marque a declaração sem a autorização daquela ação e daquele alvo.

Os agentes `opc-worker` e `opc-rescue` nunca respondem permissões.

## Por que nunca `always`

O opc só envia `once` ou `reject` e recusa `reply … always` (exit 2).

## Troca de perfil no `--resume`

O `PATCH /api/session/:id {permissions}` substitui a lista inteira. A troca de perfil no `--resume` é permitida após a confirmação das regras aplicadas.

## Stop review gate

O gate é opcional (`stopGate.enabled`, padrão `false`; ligue com `/opc:setup --enable-review-gate`). Ligado, cada parada do Claude roda um turno OpenCode que revisa o turno anterior; há uma chamada de modelo por parada.

- **Perfil:** `read-only`: nega tudo por padrão e libera somente `read`, `glob`, `skill` e `question`, além das invariantes. `grep` permanece negado; não libera Bash, edição ou web. Pedido de permissão recebe `reject` imediato.
- **Entrada:** `last_assistant_message` ou, se ausente, a última mensagem de assistente em `transcript_path`, mais contexto do working tree de até 200 KB. Conteúdo de `policy.sensitivePaths` nunca é enviado.
- **Modelo:** `stopGate.model` → `defaultModel` → modelo explícito permitido pela política.
- **Decisão:** apenas primeira linha `BLOCK: <motivo>` bloqueia; o Claude recebe `opc stop gate: <motivo>` e continua. `ALLOW:` permite.
- **Infraestrutura:** OpenCode ausente, boot falho, modelo negado, limite de jobs, timeout de 840 s, resposta malformada ou falha de preparação permitem com `systemMessage` que informa a causa redigida.
- **Laço:** com `stop_hook_active: true`, permite sem executar outro turno.
- **Desvio do codex:** timeout ou saída inválida permitem com aviso; não bloqueiam.
