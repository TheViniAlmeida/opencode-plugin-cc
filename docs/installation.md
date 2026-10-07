# Instalação do opc

## 1. Pré-requisitos

| Item | Versão | Como conferir |
|---|---|---|
| Node.js | 20 ou mais novo | `node --version` |
| OpenCode | 2.0.22 ou mais novo (somente OpenCode V2) | `opencode --version` |
| Provider no OpenCode | pelo menos um conectado | `opencode auth list` |
| git | qualquer versão recente | `git --version` |

O `opc` recusa Node < 20 com a mensagem `opc: Node.js >= 20 é obrigatório` e exit 2.

## 2. Instalar pelo marketplace

Dentro do Claude Code:

```text
/plugin marketplace add <caminho-ou-url-deste-repositório>
/plugin install opc@opencode-plugin-cc
```

O marketplace se chama `opencode-plugin-cc` e o plugin, `opc`. Depois da instalação, rode `/opc:setup`; o nome efetivo do diretório em `~/.claude/plugins/data/` deve ser informado pelo operador antes de ser tratado como confirmado.

## 3. Primeiro uso

```text
/opc:setup
```

O slash command chama o executável com o heredoc canônico abaixo; mantenha o delimitador `OPC_ARGS_5f1d0c7a_EOF` entre aspas simples para não expandir argumentos:

```bash
opc setup --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

O `/opc:setup` confere Node e OpenCode, resolve diretórios, sobe ou reaproveita o `opencode serve` do workspace numa porta livre de `127.0.0.1`, protegido por senha aleatória, e imprime um alias para o terminal.

## 4. O executável `opc`

Dentro do Claude, o diretório `bin/` do plugin entra no PATH da ferramenta Bash. No terminal, use o alias impresso pelo `/opc:setup` para que Claude e terminal usem o mesmo `OPC_DATA_DIR`:

```sh
alias opc='OPC_DATA_DIR="<diretório-de-dados>" node "<plugin>/scripts/opc-companion.mjs"'
```

## 5. Diretório de dados

Ordem de resolução, sem fallback para `$TMPDIR`:

1. `OPC_DATA_DIR`;
2. `CLAUDE_PLUGIN_DATA`;
3. diretório padrão do plugin em `~/.claude/plugins/data/`, se existir;
4. senão, `DATA_DIR_UNRESOLVED` (exit 2), pedindo `/opc:setup`.

```text
<dataDir>/
  config.json
  state/<slug>-<hash16>/
    server.json       # modo 600; contém a senha
    server.log        # modo 600
    server.lock / state.lock
    state.json
```

## 6. Servidor externo (modo attach)

```sh
export OPC_SERVER_URL=http://127.0.0.1:4096
export OPC_SERVER_PASSWORD=YOUR_SERVER_PASSWORD_HERE
```

São aceitos `http://127.0.0.1`, `http://localhost` ou `https://`; outro endereço HTTP resulta em `INSECURE_SERVER_URL` (exit 2). Nesse modo o opc não sobe, encerra ou aplica override ao servidor externo.

## 7. Desenvolvimento

```sh
npm test
npm run scan-secrets
OPC_LIVE=1 node --test tests/live/f0-connection.mjs
```

Não há dependências: não rode `npm install`.
