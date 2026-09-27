# Changelog

Todas as mudanças relevantes deste projeto são registradas aqui.
O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa
[versionamento semântico](https://semver.org/lang/pt-BR/).

## [Unreleased]

### Adicionado (F1 — descoberta, configuração e onboarding)

- `/opc:providers`, `/opc:models`, `/opc:agents` e `/opc:catalog`, com a política do opc aplicada (`--allowed`, `--all`, `--verbose`, `--mode`).
- `/opc:config` (`get`, `set`, `unset`, `add`, `remove`, `show --effective`, `validate`, `path`) e o assistente de terminal `opc config init`.
- Onboarding guiado no `/opc:setup` (instalação do OpenCode, provider, modelos, política, projeto e aliases) com rascunho retomável e commit atômico validado contra o servidor.
- Esquema completo da configuração, merge restritivo do `.opc.json`, chaves travadas (`policy.*`, `permissionProfiles`, `server.configOverride`) e aviso de chaves com aparência de segredo.
- Normalização de IDs de modelo (nome curto, ambiguidade, prefixo `=`), aliases, validação de variants e checagem de modelos fixados por agentes e commands.

## [0.1.0] - 2026-09-26

F0 — fundação e conexão.

### Adicionado

- Marketplace `opencode-plugin-cc` e plugin `opc`, com executável `bin/opc`.
- CLI `opc` com checagem de Node ≥ 20, `--args-stdin`, `--cwd`, `--json` e exit codes.
- `/opc:setup`: diagnóstico e ciclo de vida do `opencode serve` por workspace, inclusive `--stop-server [--force]` com confirmação.
- Núcleo de redação, locks verificáveis, estado privado, merge restritivo de configuração, HTTP e SSE.
- Testes unitários, integração com OpenCode falso, testes ao vivo, contrato de formas e scanner de segredos.
- Documentação de instalação, arquitetura, solução de problemas e relatório da F0.
