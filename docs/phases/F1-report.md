# Relatório da fase F1 — Descoberta, configuração e onboarding

- **Data:** 27/09/2026
- **Branch / PR:** `feat/opc-f1` / PR não informado
- **Ambiente:** Node 22; OpenCode 1.18.x; Linux; modelo ao vivo do provider pessoal do operador

## Portão

| Item | Status | Evidência |
|---|---|---|
| `npm test` 100% verde | PASSOU | 424/424 pass, 0 fail (Node 22) |
| Checklist ao vivo F1 | PASSOU | `f1-discovery`: 10/10 passou |
| Contrato e cobertura de fixtures | PASSOU | sem divergências; snapshot de 4,6 KB |
| Documentação com exemplos executados | PASSOU | exemplos locais redigidos; scanner final desta tarefa registrado no relatório de tarefa |
| CHANGELOG | PASSOU | entrada F1 em `Unreleased` |

CI em Node 20 e 22: **NÃO VALIDADO** neste relatório; a execução é prevista no PR, cujo resultado não foi fornecido.

## Aceite de integração

| Critério | Status |
|---|---|
| Descoberta por fixtures, sem chave de provider no JSON | PASSOU |
| `--allowed` esconde e uso explícito é bloqueado | PASSOU |
| Merge restritivo | PASSOU |
| Aliases, nome curto e ambiguidade | PASSOU |
| `config validate` para modelo, variant, alias e chave suspeita | PASSOU |
| `setup commit` recusa padrão negado | PASSOU |
| Interrupção mantém apenas o rascunho | PASSOU |
| Chave travada sem TTY é recusada | PASSOU |
| TTY roteirizado | PASSOU |
| Modelo fixado negado é recusado | PASSOU |
| Catálogo de commands e skills | PASSOU |
| Primeiro uso sem config | PASSOU |

## Aceite ao vivo

| Critério | Status | Evidência |
|---|---|---|
| Modelos `--all` correspondem à listagem por provider | PASSOU | comparação por provider |
| Agentes correspondem à API | PASSOU | CLI é subconjunto; ver desvio |
| Onboarding guiado na sessão do Claude | NÃO VALIDADO | depende do operador |
| `opc config init` manual | NÃO VALIDADO | depende do operador |
| Itens de trabalho ausentes de `--allowed` e uso recusado | PASSOU | política simulada no teste ao vivo |
| Variant válida aceita e inválida recusada | PASSOU | validação antes da sessão |
| Nenhuma credencial no JSON | PASSOU | scanner limpo |

## Desvios

- A CLI `opencode agent list`, fora de projeto, lista somente agentes nativos; a API do servidor também inclui agentes de configuração/plugins. O critério passou a ser: todo agente da CLI aparece em `/opc:agents`, e `/opc:agents` corresponde a `GET /agent`.
- A primeira suíte ao vivo excedeu dez minutos e deixou um servidor de teste órfão; sua identidade foi confirmada e ele foi encerrado. Servidores preexistentes permaneceram intactos. Depois disso, os testes foram executados individualmente.
- Fixtures receberam campos opcionais reais de custo, limite, capacidades e parâmetros de agentes; a cobertura final não teve divergências.

## Itens A CONFIRMAR levantados na F1

1. `opencode models <provider>`: confirmado; há fallback para a lista completa quando o argumento não é aceito.
2. Formato de `opencode agent list`: confirmado o desvio descrito acima.
3. Campos ausentes nas fixtures: resolvido; não há divergências após a atualização.

## Itens pendentes do operador

1. Executar o onboarding completo dentro do Claude Code com `OPC_DATA_DIR` descartável.
2. Executar `opc config init` no terminal e percorrer filtros e seleções.
3. Confirmar a instalação do plugin no Claude Code.

## Git e gravação dupla

- **Commit documental criado:** `efd8981` — `docs: add F1 configuration, commands and phase report`.
- PR: não criado.
- Gravação dupla: N/A nesta tarefa documental; não foi solicitada e o ambiente não oferece a colmeia.
