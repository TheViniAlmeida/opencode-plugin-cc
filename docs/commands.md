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
