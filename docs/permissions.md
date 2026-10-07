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

## Invariantes

Aplicadas por último, em todos os perfis:

1. `external_directory * deny`;
2. para cada `policy.sensitivePaths`, `read`, `grep` e `glob` recebem `deny`;
3. agentes em `policy.agents.deny` recebem `subagent <glob> deny`;
4. ferramentas em `policy.tools.deny` recebem `<padrão> * deny`;
5. em `write` e em `custom` com shell, comandos destrutivos recebem `shell <padrão> ask`;
6. `browser * deny` em todos os perfis.

Os globs usam `*` inclusive para `/`; os caminhos sensíveis padrão incluem arquivos `.env`,
chaves privadas e diretórios SSH.

## Comandos destrutivos

A lista embutida cobre remoção recursiva, força no Git, Docker, `kubectl delete`, formatação ou
sobrescrita de disco, `find -delete`, desligamento e SQL `DROP`/`TRUNCATE`.
`policy.destructiveBash` só acrescenta padrões. Pedidos destrutivos vão sempre ao usuário,
independentemente do aprovador.

A análise reconhece comandos encapsulados, inclusive `bash -c`, `eval`, `sudo`/`doas`, wrappers,
substituições e segmentos compostos. Comando impossível de analisar, sintaxe ambígua, heredoc,
expansão em posição de comando ou fonte externa também exige o usuário (fail-safe). Isso pode
gerar falso positivo benigno, como argumento de busca contendo `TRUNCATE`.

## Sessões filhas

No V2, a ferramenta `subagent` cria a filha com `parentID`; ela herda as `permissions` e o modelo da sessão pai. O opc acompanha a filha e confirma as regras aplicadas.

## Ponte de pedidos e aprovador

Em `read-only`, pedidos são rejeitados imediatamente. Em `write`/`custom`, o job entra em
`waiting_permission`; em primeiro plano retorna 3 e o worker espera `policy.permissionTimeoutSec`
(padrão 600 s), quando rejeita sem aprovador. Rejeitar um pedido rejeita os irmãos pendentes.

| Aprovador | `reply once` | `reply reject` |
| --- | --- | --- |
| `user` (padrão) | Exige `--confirmed-by-user` | Livre |
| `claude` | Livre, exceto destrutivo, `external_directory` e caminho sensível, que exigem confirmação do usuário | Livre |

Os agentes `opc-worker` e `opc-rescue` nunca respondem permissões.

## Por que nunca `always`

O opc só envia `once` ou `reject` e recusa `reply … always` (exit 2).

## Troca de perfil no `--resume`

O `PATCH /api/session/:id {permissions}` substitui a lista inteira. A troca de perfil no `--resume` é permitida após a confirmação das regras aplicadas.

## Stop review gate

O gate é opcional (`stopGate.enabled`, padrão `false`; ligue com `/opc:setup --enable-review-gate`). Ligado, cada parada do Claude roda um turno OpenCode que revisa o turno anterior; há uma chamada de modelo por parada.

- **Perfil:** `read-only`: nega tudo por padrão e libera somente `read`, `glob`, `grep`, `skill` e `question`, além das invariantes. Não libera Bash, edição ou web. Pedido de permissão recebe `reject` imediato.
- **Entrada:** `last_assistant_message` ou, se ausente, a última mensagem de assistente em `transcript_path`, mais contexto do working tree de até 200 KB. Conteúdo de `policy.sensitivePaths` nunca é enviado.
- **Modelo:** `stopGate.model` → `defaultModel` → modelo explícito permitido pela política.
- **Decisão:** apenas primeira linha `BLOCK: <motivo>` bloqueia; o Claude recebe `opc stop gate: <motivo>` e continua. `ALLOW:` permite.
- **Infraestrutura:** OpenCode ausente, boot falho, modelo negado, limite de jobs, timeout de 840 s, resposta malformada ou falha de preparação permitem com `systemMessage` que informa a causa redigida.
- **Laço:** com `stop_hook_active: true`, permite sem executar outro turno.
- **Desvio do codex:** timeout ou saída inválida permitem com aviso; não bloqueiam.
