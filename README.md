# opc — OpenCode dentro do Claude Code

Plugin do Claude Code que usa o [OpenCode](https://opencode.ai) como executor: o Claude delega
análises, reviews e tarefas para modelos do OpenCode, com servidor gerenciado por workspace e
permissões controladas pelo plugin.

> Estado: **F1 — descoberta, configuração e onboarding**. Além do diagnóstico do servidor, os
> comandos de descoberta, configuração e onboarding já estão disponíveis.

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

## Início rápido

1. Execute `/opc:setup` e responda ao onboarding: provider, modelo padrão, política, projeto e aliases.
2. Consulte `/opc:models --allowed` e `/opc:agents` para ver o que o `opc` pode usar.
3. Para ajustes não interativos, use `/opc:config set …`. Alterações de política são feitas no terminal com `opc config init`.
4. O primeiro review chega na F2b, com `/opc:review`.

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
- [Configuração](docs/configuration.md)
- [Comandos F1](docs/commands.md)
- [Relatório da F1](docs/phases/F1-report.md)
- [CHANGELOG](CHANGELOG.md)

## Licença e créditos

Apache-2.0 (veja [LICENSE](LICENSE) e [NOTICE](NOTICE)). Estrutura inspirada no [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0). As capacidades de swarm são inspiradas no [apoapps/swarm-code-plugin](https://github.com/apoapps/swarm-code-plugin), reimplementadas sem copiar código nem texto.
