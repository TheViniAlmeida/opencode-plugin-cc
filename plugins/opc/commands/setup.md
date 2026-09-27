---
description: Diagnostica o OpenCode para o opc, sobe ou reaproveita o servidor do workspace, ou encerra esse servidor
argument-hint: '[--stop-server [--force]]'
allowed-tools: Bash(opc:*), AskUserQuestion
---

Rode o diagnóstico do opc repassando os argumentos do usuário **somente** pelo heredoc abaixo. Não
edite, reordene nem interprete os argumentos, e mantenha o delimitador entre aspas simples, para que
o shell não expanda nada:

```bash
opc setup --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

Se os argumentos contiverem `--force` (sempre junto com `--stop-server`):

- Antes de rodar, use `AskUserQuestion` exatamente uma vez para confirmar, com as opções
  `Encerrar mesmo com jobs ativos` e `Cancelar`.
- Só se o usuário escolher encerrar, rode com `--confirmed-by-user` **fora** do heredoc:

```bash
opc setup --confirmed-by-user --args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'
$ARGUMENTS
OPC_ARGS_5f1d0c7a_EOF
```

- Se o usuário cancelar, não rode nada e diga que o servidor continua ativo.
- Nunca acrescente `--confirmed-by-user` sem essa confirmação.

Regras de saída:

- Apresente ao usuário a saída do comando como veio (ela já está em Markdown e sem segredos).
- Se o status for "requer atenção", destaque os próximos passos listados.
- Se o OpenCode não estiver instalado, oriente `npm install -g opencode-ai` e rodar `/opc:setup`
  de novo (a instalação guiada chega na F1).
- Preserve a linha `alias opc=...` da seção "Terminal", para o usuário copiar.
- Não tente corrigir nada por conta própria.
