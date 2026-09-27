# Changelog

Todas as mudanças relevantes deste projeto são registradas aqui.
O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa
[versionamento semântico](https://semver.org/lang/pt-BR/).

## [Unreleased]

## [0.1.0] - 2026-09-26

F0 — fundação e conexão.

### Adicionado

- Marketplace `opencode-plugin-cc` e plugin `opc`, com executável `bin/opc`.
- CLI `opc` com checagem de Node ≥ 20, `--args-stdin`, `--cwd`, `--json` e exit codes.
- `/opc:setup`: diagnóstico e ciclo de vida do `opencode serve` por workspace, inclusive `--stop-server [--force]` com confirmação.
- Núcleo de redação, locks verificáveis, estado privado, merge restritivo de configuração, HTTP e SSE.
- Testes unitários, integração com OpenCode falso, testes ao vivo, contrato de formas e scanner de segredos.
- Documentação de instalação, arquitetura, solução de problemas e relatório da F0.
