# Arquitetura do opc

## Visão geral

```text
Claude Code ──(slash command / hook)──> bin/opc ──> opc-companion.mjs ──> commands/<sub>.mjs
                                                                         │
                                                         scripts/lib/*.mjs (núcleo)
                                                                         │ HTTP + SSE (API v1)
                                                                         ▼
                                                  opencode serve (127.0.0.1:<porta>, senha)
```

Um servidor `opencode serve` é gerenciado por workspace e compartilhado pelas sessões do Claude nele. A saída normal vai a stdout; progresso vai a stderr com prefixo `[opc]`; `--json` está disponível nos subcomandos e as saídas passam por redação.

O slash command de setup repassa argumentos sem interpretação por meio do delimitador canônico `OPC_ARGS_5f1d0c7a_EOF`:

```bash
opc setup --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

## Módulos da F0

| Módulo | Responsabilidade |
|---|---|
| `opc-error.mjs` | erros tipados e exit codes |
| `redact.mjs` | redação de chaves e segredos |
| `args.mjs` | argumentos sem expansão e `--args-stdin` |
| `process.mjs` | identidade, spawn destacado e kill em grupo |
| `locks.mjs` | locks `O_EXCL` com dono verificável |
| `state.mjs` | diretório de dados, estado por workspace e modos privados |
| `config.mjs` | config base e merge restritivo |
| `http.mjs` | HTTP com Basic auth, diretório e timeouts |
| `sse.mjs` | SSE, liveness, reconexão e roteamento |
| `server.mjs` | ciclo de vida do servidor |

## Ciclo de conexão (`ensureServer`)

1. Adquire `server.lock` para serializar spawn e encerramento.
2. Em attach (`OPC_SERVER_URL`), valida URL e health; nunca sobe ou derruba o servidor externo.
3. Reaproveita registro cuja identidade, health e versão conferem; registro inválido é descartado sem sinal.
4. Escolhe porta livre em `127.0.0.1`, inicia `opencode serve` destacado e registra stdout/stderr em `server.log`.
5. Aguarda `listening on` na porta pedida ou health; tenta até três portas, confirma versão mínima e grava `server.json` atomicamente em modo 600.
6. Aquece `/agent` e verifica `/config`: `share: auto` bloqueia sessões; defaults de modelo negados viram aviso.

Resultado ao vivo do portão: primeiro setup em aproximadamente 42 s, porta 40405 e health positivo; reaproveitamento em aproximadamente 8,6 s; encerramento em aproximadamente 3,5 s com fallback para SIGKILL previsto. O reaproveitamento lento inclui a checagem de mundo e aquecimento; investigação fica para F1.

## Encerramento e eventos

`stopServer` tenta `POST /global/dispose`, SIGTERM no grupo e, após 3 s, SIGKILL; a identidade é conferida antes de cada sinal. SSE usa `GET /event?directory=…`, liveness de 30 s e reconexão com esperas de 0,5/1/2/4/8 s.

## Segurança

- O servidor escuta somente em `127.0.0.1` e recebe senha aleatória a cada boot, guardada apenas no `server.json` privado.
- Chaves de provider e senha não aparecem em saída, log ou documentação.
- O plugin não escreve na configuração nem na autenticação do OpenCode.
- Nenhum sinal é enviado a processo cuja identidade não confira.
