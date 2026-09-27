# opc — OpenCode dentro do Claude Code

Plugin do Claude Code que usa o [OpenCode](https://opencode.ai) como executor: o Claude delega
análises, reviews e tarefas para modelos do OpenCode, com servidor gerenciado por workspace e
permissões controladas pelo plugin.

> Estado: **F0 — fundação e conexão**. Nesta fase existe só o `/opc:setup` (diagnóstico e ciclo
> de vida do servidor). Os demais comandos chegam nas fases seguintes.

## Requisitos

- Claude Code com suporte a plugins.
- Node.js 20 ou mais novo (o `opc` confere a versão ao iniciar).
- OpenCode 1.18.0 ou mais novo (testado com 1.18.32): `npm install -g opencode-ai`.
- Pelo menos um provider conectado no OpenCode (`opencode auth login`).
- Linux validado; macOS e Windows: código portátil, não validado.

## Instalação

```text
/plugin marketplace add <caminho-ou-url-deste-repositório>
/plugin install opc@opencode-plugin-cc
/opc:setup
```

Veja os detalhes em [docs/installation.md](docs/installation.md). A instalação no Claude Code e a confirmação do diretório de dados ainda são itens do operador.

## Início rápido (F0)

No Claude Code, execute `/opc:setup`. Para preservar argumentos literalmente quando a invocação for feita pelo comando interno, o plugin usa este heredoc canônico:

```bash
opc setup --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

O teste ao vivo de conexão confirmou um primeiro `setup` com exit 0, porta 40405, OpenCode 1.18.32 e `healthy=true`; o segundo reaproveitou o mesmo servidor. Esses resultados vieram da CLI, não de uma instalação no Claude Code.

## Mapa de comandos

| Comando | Fase | Situação |
|---|---|---|
| `/opc:setup` | F0 | diagnóstico, sobe/reaproveita o servidor, `--stop-server [--force]` |
| `/opc:config`, `/opc:providers`, `/opc:models`, `/opc:agents`, `/opc:catalog` | F1 | planejado |
| `/opc:task`, `/opc:ask`, `/opc:plan`, `/opc:status`, `/opc:result`, `/opc:cancel`, `/opc:permissions` | F2a | planejado |
| `/opc:review`, `/opc:adversarial-review`, `/opc:rescue`, stop gate, hooks | F2b | planejado |
| `/opc:sessions`, `/opc:session`, `/opc:subagent`, `/opc:command`, `/opc:attach` | F3 | planejado |
| roteamento/fallback, delegação, `opc-worker`, `opc monitor` | F4a | planejado |
| `/opc:orchestrate` | F4b | planejado |
| `/opc:conclave` | F4c | planejado |
| servidor MCP, `/opc:transfer` | F5 | planejado |

## Documentação

- [Instalação](docs/installation.md)
- [Arquitetura](docs/architecture.md)
- [Solução de problemas](docs/troubleshooting.md)
- [Relatório da F0](docs/phases/F0-report.md)
- [CHANGELOG](CHANGELOG.md)

## Licença e créditos

Apache-2.0 (veja [LICENSE](LICENSE) e [NOTICE](NOTICE)). Estrutura inspirada no [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0). As capacidades de swarm são inspiradas no [apoapps/swarm-code-plugin](https://github.com/apoapps/swarm-code-plugin), reimplementadas sem copiar código nem texto.
