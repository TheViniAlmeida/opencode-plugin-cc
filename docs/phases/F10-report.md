# F10 — modo remoto · relatório de fase

- **Data:** 08/10/2026 (America/Belem).
- **Branch:** `feat/opc-f10-remote`.
- **Objetivo:** usar o opc com um OpenCode V2 em outra máquina, com o repo sincronizado via git, inclusive por
  `http://` num IP privado (por exemplo `http://10.0.0.5:4096`), ligado por configuração ou pelo setup.
- **Fatos ao vivo:** [F10-live-output.md](F10-live-output.md).

## Portão

| Item | Evidência | Resultado |
|---|---|---|
| Suíte completa | `node scripts/run-tests.mjs`: 2117 testes, 2116 aprovados, 0 falhas, 0 cancelados (1 ignorado) | PASSOU |
| `npm run scan-secrets` | `scan-secrets: nenhum achado.` | PASSOU |
| `git diff --check` | Saída vazia, exit 0 | PASSOU |
| Guarda de docs da F10 | `tests/unit/docs-f10.test.mjs` | PASSOU |
| http em IP privado sem `server.allowPrivateHttp` | `opc models` exit 2, `INSECURE_SERVER_URL`, a mensagem manda ligar a chave | PASSOU |
| http em IP privado com a chave | V2 isolado escutando num IP privado desta máquina: `opc models` exit 0, catálogo com `probe-gw`, aviso de conexão sem TLS e aviso de raiz remota no stderr | PASSOU |
| Raiz remota por `OPC_REMOTE_ROOT` | `opc session new` a partir do checkout local criou a sessão com `location.directory` igual à raiz remota (um clone git do repo local), e `opc sessions` a lista | PASSOU |
| Raiz remota por `server.remoteRoots` | mesmo resultado, sem a variável de ambiente | PASSOU |
| `transfer` com raiz remota | import na raiz remota; a linha de retomada usa `"$OPC_SERVER_PASSWORD"` e não contém a senha | PASSOU |
| Servidor em outra máquina física | o teste usou um IP privado desta máquina e um clone em outro caminho; a rede é a mesma pilha, mas o host remoto real não foi exercitado | NÃO VALIDADO |
| TUI pela linha de retomada com raiz remota | a linha foi gerada, mas não executada num pty nesta fase | NÃO VALIDADO |

## O que mudou

- **`server.allowPrivateHttp`** (boolean, padrão `false`, chave travada, só global): o attach aceita `http://` quando
  o host é um IP literal privado (IPv4 10/8, 172.16/12, 192.168/16, 100.64/10; IPv6 fc00::/7). Nomes DNS seguem
  exigindo `https://` ou loopback. Com a chave ligada, o attach avisa que a senha e o conteúdo trafegam sem TLS. O
  setup ganhou uma etapa opcional (padrão "não").
- **`server.remoteRoots`** (mapa caminho local → caminho remoto POSIX, chave travada, só global) e **`OPC_REMOTE_ROOT`**
  (sobrepõe o mapa no workspace atual): só em attach. Todos os pontos que mandam o diretório ao servidor
  (`x-opencode-directory`, filtro de `opc sessions`, export e import do `transfer`) usam o caminho remoto. No modo
  gerenciado, a variável é ignorada com aviso.
- **Aviso de sincronização:** com raiz remota, o attach lembra que as ferramentas rodam na máquina do servidor e que
  a sincronização é via git (push aqui e pull lá antes; commit/push lá e pull aqui depois de tarefas com escrita).
- **Docs:** instalação (§6: IP privado, túnel SSH, raiz remota e fluxo git), configuração, troubleshooting, CHANGELOG
  e a sonda `tests/live/f10-remote.mjs`.

## Pendências e achados

- O contrato V2 não tem endpoint que informe branch ou commit do diretório no servidor; o opc não compara o estado
  git das duas máquinas. Confira `git rev-parse HEAD` nos dois lados.
- `opc status` não mostra o modo attach nem a raiz remota; o `/opc:setup` mostra.
- NÃO VALIDADO: servidor em outra máquina física e a TUI anexada com raiz remota (ver o portão).
- Manuais herdados da F8: instalação real do plugin (§15, item 8), `/clear` interativo (item 9), Agent Teams
  (item 11), `/opc:attach --pane` e a TUI independente junto do servidor do plugin (item 12).
