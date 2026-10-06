# opc — OpenCode dentro do Claude Code

Plugin do Claude Code que usa o [OpenCode](https://opencode.ai) como executor: o Claude delega
análises, reviews e tarefas para modelos do OpenCode, com servidor gerenciado por workspace e
permissões controladas pelo plugin.

> Estado: **F6 — migração para OpenCode V2 implementada, portão em validação**. Descoberta, onboarding,
> turnos, reviews, sessões, delegação, jobs, orquestração e conclave estão disponíveis.
> O portão F6 e os procedimentos manuais no Claude Code/TUI seguem **NÃO VALIDADOS**.

## Requisitos

- Claude Code com suporte a plugins.
- Node.js 20 ou mais novo (o `opc` confere a versão ao iniciar).
- OpenCode ≥ 2.0.22 (somente V2). Configure `server.opencodeBin` na configuração global ou `OPC_OPENCODE_BIN` para apontar ao executável V2 quando outro `opencode` estiver primeiro no PATH.
- Pelo menos um provider conectado no OpenCode (`opencode auth login`).
- Linux validado; macOS e Windows: código portátil, não validado.

## Instalação

```text
/plugin marketplace add <caminho-ou-url-deste-repositório>
/plugin install opc@opencode-plugin-cc
/opc:setup
```

Veja os detalhes em [docs/installation.md](docs/installation.md). A instalação no Claude Code e a confirmação do diretório de dados ainda são itens do operador.

## Início rápido

1. Execute `/opc:setup` e responda ao onboarding: provider, modelo padrão, política, projeto e aliases.
2. Consulte `/opc:models --allowed` e `/opc:agents` para ver o que o `opc` pode usar.
3. Para ajustes não interativos, use `/opc:config set …`. Alterações de política são feitas no terminal com `opc config init`.
4. Faça uma mudança e rode `/opc:review`.

Para preservar argumentos literalmente quando a invocação for feita pelo comando interno, o plugin usa este heredoc canônico:

```bash
opc setup --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

O portão F1 confirmou descoberta, política, onboarding do companion e JSON sem credenciais. A validação completa do onboarding dentro do Claude Code continua pendente do operador.

## Mapa de comandos

| Comando | Fase | Situação |
|---|---|---|
| `/opc:setup` | F0 | diagnóstico, sobe/reaproveita o servidor, `--stop-server [--force]` |
| `/opc:config`, `/opc:providers`, `/opc:models`, `/opc:agents`, `/opc:catalog` | F1 | disponível |
| `/opc:task`, `/opc:ask`, `/opc:plan`, `/opc:status`, `/opc:result`, `/opc:cancel`, `/opc:permissions` | F2a | disponível |
| `/opc:review`, `/opc:adversarial-review`, `/opc:rescue`, stop gate, hooks | F2b | disponível |
| `/opc:sessions`, `/opc:session`, `/opc:subagent`, `/opc:command`, `/opc:attach` | F3 | disponível |
| roteamento/fallback, delegação, `opc-worker`, `opc monitor` | F4a | disponível |
| `/opc:orchestrate` | F4b | disponível |
| `/opc:conclave` | F4c | disponível |
| servidor MCP, `/opc:transfer` | F5 | implementado, em validação |

## Mapa do mínimo (paridade com o codex-plugin-cc)

| Comando | Para que serve |
| --- | --- |
| `/opc:setup` | Diagnóstico, instalação guiada, onboarding, `--stop-server`, `--enable-review-gate`/`--disable-review-gate` |
| `/opc:review` | Review das mudanças locais, do working tree ou branch, com pergunta aguardar/background |
| `/opc:adversarial-review` | Review que desafia a abordagem, com texto de foco |
| `/opc:rescue` | Delega investigação ou correção ao OpenCode, continuando ou iniciando sessão |
| `/opc:task`, `/opc:ask`, `/opc:plan` | Turnos avulsos de escrita, pergunta e plano |
| `/opc:orchestrate` | Decompõe tarefas em partes executadas por vários modelos e sintetiza os resultados |
| `/opc:conclave` | Consulta vários modelos em paralelo para opinião, debate ou review cruzado |
| `/opc:status`, `/opc:result`, `/opc:cancel` | Acompanha, lê e cancela jobs |
| `opc monitor` | Acompanha jobs do workspace no terminal, sem alterar estado |
| `/opc:sessions`, `/opc:session` | Lista e gerencia sessões, inclusive fork, revert/unrevert, resumo e diff |
| `/opc:subagent` | Executa agentes/modelos em paralelo como grupo de jobs |
| `/opc:command` | Roda um slash command do OpenCode em job próprio |
| `/opc:attach` | Abre a sessão na TUI; `--pane` abre split no tmux e só o usuário invoca |
| `/opc:permissions` | Responde pedidos de permissão e perguntas do OpenCode |
| servidor MCP, `/opc:transfer` | Ferramentas `opc_*` e transferência da conversa para uma sessão OpenCode (F5, em validação) |
| Hooks | `SessionStart`/`SessionEnd` no ciclo do servidor e `Stop` no gate opcional |

Primeiro review: `/opc:setup` → faça uma mudança → `/opc:review`.

## Servidor MCP

O plugin registra o servidor MCP `opc` (stdio, sem dependências), com as ferramentas `opc_*`
para descoberta, turnos, subagentes, orquestração, conclave, sessões, jobs e permissões.
O Claude chama o mesmo despachante dos comandos `/opc:`, com as mesmas políticas e
confirmações. Jobs longos retornam seu ID em background. Configuração é exposta apenas
para leitura; revert/unrevert, parada do servidor, review e transfer ficam nos comandos
do usuário. Veja o [catálogo e o formato dos resultados](docs/architecture.md#servidor-mcp-f5).

Para levar a conversa atual para o OpenCode, use `/opc:transfer` e depois
`opencode --server <url> -s <id>` no terminal, com `OPENCODE_SERVER_PASSWORD` no ambiente. A [referência de comandos](docs/commands.md#opctransfer)
explica a conversão, os limites e os erros. O uso real no Claude e a retomada interativa
da sessão transferida ainda precisam de validação no portão F6.

## Documentação

- [Instalação](docs/installation.md)
- [Arquitetura](docs/architecture.md)
- [Solução de problemas](docs/troubleshooting.md)
- [Relatório da F0](docs/phases/F0-report.md)
- [Configuração](docs/configuration.md)
- [Comandos](docs/commands.md)
- [Relatório da F1](docs/phases/F1-report.md)
- [Relatório da F3](docs/phases/F3-report.md)
- [Swarm: roteamento, fallback, monitor e orquestração](docs/swarm.md)
- [Relatório da F4a](docs/phases/F4a-report.md)
- [Relatório da F4b](docs/phases/F4b-report.md)
- [Conclave](docs/conclave.md)
- [Relatório da F4c](docs/phases/F4c-report.md)
- [Plano e portão da F5 (em validação)](docs/superpowers/plans/2026-09-26-opc-F5-mcp-transfer.md)
- [Relatório da F5 (aceite parcial)](docs/phases/F5-report.md)
- [Relatório e portão da F6](docs/phases/F6-report.md)
- [CHANGELOG](CHANGELOG.md)

## Licença e créditos

Apache-2.0 (veja [LICENSE](LICENSE) e [NOTICE](NOTICE)). Estrutura inspirada no [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0). As capacidades de swarm são inspiradas no [apoapps/swarm-code-plugin](https://github.com/apoapps/swarm-code-plugin), reimplementadas sem copiar código nem texto.
