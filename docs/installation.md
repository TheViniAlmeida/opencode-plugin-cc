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

São aceitos `https://`, `http://127.0.0.1` e `http://localhost`; outro endereço HTTP resulta em `INSECURE_SERVER_URL` (exit 2), salvo um IP privado com `server.allowPrivateHttp` ligado (abaixo). Nesse modo o opc não sobe, encerra ou aplica override ao servidor externo.

### Servidor em outra máquina

O OpenCode V2 pode rodar em outra máquina da rede (por exemplo, um servidor com mais recursos), com o repositório sincronizado via git. Há três formas de chegar até ele, da mais segura para a menos segura:

1. **`https://`** com certificado válido: aceito sem configuração extra.
2. **Túnel SSH** para o loopback local, sem expor a senha na rede:

   ```sh
   ssh -N -L 4096:127.0.0.1:4096 usuario@host-do-servidor
   export OPC_SERVER_URL=http://127.0.0.1:4096
   ```

3. **`http://` em IP privado** (opt-in): só IP literal nas faixas `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10` (CGNAT/Tailscale) e IPv6 `fc00::/7` (ULA, entre colchetes na URL). Nomes DNS não valem, porque podem resolver para um IP público. Ligue a chave travada na config global, no seu terminal:

   ```sh
   opc config set server.allowPrivateHttp true --tty-confirm
   export OPC_SERVER_URL=http://10.0.0.20:4096
   ```

   Risco: sem TLS, a senha (`OPC_SERVER_PASSWORD`) e o conteúdo das sessões trafegam em claro na rede privada; qualquer máquina nessa rede que capture o tráfego os lê. A cada conexão o opc avisa no stderr: "Conexão sem TLS com <host>: a senha e o conteúdo trafegam em claro na rede privada." O `/opc:setup` também pergunta por essa chave no onboarding inicial (padrão: não).

### Raiz remota (onde as ferramentas rodam)

No attach, o opc informa ao servidor o diretório do workspace (header `x-opencode-directory`). Por padrão é o caminho local, que talvez não exista na outra máquina. Para apontar para o clone remoto:

- `OPC_REMOTE_ROOT=/caminho/absoluto/no/servidor` vale para o workspace atual e tem prioridade;
- ou o mapa global travado `server.remoteRoots` (caminho local absoluto → caminho remoto absoluto POSIX). Uma chave pode ser a raiz do repo ou um diretório pai; num pai, o subdiretório é anexado com `/`:

  ```sh
  opc config set server.remoteRoots '{"/home/usuario/dev":"/srv/dev"}' --tty-confirm
  ```

Os dois só valem em attach; no modo gerenciado são ignorados (com aviso, para `OPC_REMOTE_ROOT`). O `.opc.json` não aceita essas chaves: um repositório não pode redirecionar onde as ferramentas rodam no servidor. O `/opc:setup` mostra a raiz remota em uso (`- raiz remota: …`).

NÃO VALIDADO: a TUI aberta pela linha do `/opc:attach` ou do `transfer` com raiz remota. A linha faz `cd` no checkout local e anexa a TUI ao servidor remoto; a sessão é aberta pelo id, mas o diretório que a TUI informa ao servidor pode ser o local.

Fluxo git: as ferramentas leem e escrevem o clone **remoto**. Antes da tarefa, faça push aqui e pull lá; depois de tarefas com escrita, faça commit/push lá e pull aqui. O opc lembra disso a cada conexão com raiz remota. O contrato do OpenCode V2 usado pelo opc não expõe o branch/commit do diretório no servidor, então o opc não compara os dois lados: confira você mesmo (`git rev-parse HEAD` nas duas máquinas).

## 7. Desenvolvimento

```sh
npm test
npm run scan-secrets
OPC_LIVE=1 node --test tests/live/f0-connection.mjs
```

Não há dependências: não rode `npm install`.
