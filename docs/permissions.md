# Permissões

O opc não altera a configuração global do OpenCode. Cada sessão criada recebe um perfil de regras
`{permission, pattern, action}`. A última regra que casa vence; regras da sessão vencem as do
agente e da configuração global.

## Perfis

### `read-only` (padrão)

Usado por `task` sem `--write`, `ask` e `plan`. Começa com `* * deny`, libera `read`, `glob`,
`list`, `lsp`, `skill` e `todowrite`, e então acrescenta as invariantes. `grep` permanece
negado: padrões de grep podem ser termos de busca, e não caminhos, impedindo a proteção segura
dos caminhos sensíveis. Não há `bash`, `edit`, `task`, `webfetch`, `websearch` nem `question`.
Pedidos residuais são rejeitados pela ponte.

### `write` (`--write`)

Herda o agente `build` e as regras do usuário; o opc acrescenta invariantes, inclusive
`bash <padrão> ask` para a lista destrutiva e `doom_loop * ask`.

### `custom:<nome>` (`--profile <nome>`)

É `read-only` mais as regras de `permissionProfiles.<nome>` da configuração global (chave
travada) e as invariantes. Se liberar bash, a lista destrutiva também é anexada como `ask`.
Não existe perfil ou flag que libere tudo.

## Invariantes

Aplicadas por último, em todos os perfis:

1. `external_directory * deny`;
2. para cada `policy.sensitivePaths`, `read`, `grep`, `glob` e `list` recebem `deny`;
3. agentes em `policy.agents.deny` recebem `task <glob> deny`;
4. ferramentas em `policy.tools.deny` recebem `<padrão> * deny`;
5. em `write` e em `custom` com bash, comandos destrutivos recebem `bash <padrão> ask`;
6. `doom_loop *` recebe `ask` em `write` e `deny` nos demais.

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

No OpenCode 1.18.32, uma filha criada por `task` herda apenas `deny` e `external_directory`.
Ao receber `session.created`, o opc aplica o perfil por `PATCH /session/:filha`; há uma janela
curta até o PATCH. Se esse PATCH ou callback crítico falhar, as sessões acompanhadas são
abortadas e o job falha.

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

No OpenCode 1.18.32, `always` fica em memória para o diretório inteiro, alcança todas as sessões
da instância e pode prevalecer sobre um `deny` de perfil. O opc só envia `once` ou `reject`,
recusa `reply … always` (exit 2) e a API também se recusa a montar esse corpo.

## Troca de perfil no `--resume`

O `PATCH /session/:id {permission}` anexa regras, em vez de substituí-las (§15.3 confirmado ao
vivo). Mesmo perfil não envia nada. `read-only` ou `custom` após `write` anexa um novo `* * deny`
e neutraliza regras anteriores. `write` após `read-only` retorna exit 2
`PROFILE_SWITCH_UNSUPPORTED`: o deny antigo continuaria valendo; use `--fresh`.
