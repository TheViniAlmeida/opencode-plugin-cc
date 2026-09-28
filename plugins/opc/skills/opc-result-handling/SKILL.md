---
name: opc-result-handling
description: Internal guidance for presenting opc (OpenCode) job output and handling pending permission requests and questions from opc jobs
user-invocable: false
---

# opc result handling

## Apresentação da saída

- Apresente a saída do opc sem alterações: texto final, saída estruturada, caminhos de arquivo e números de linha exatamente como impressos.
- Mantenha as linhas de acompanhamento (`/opc:status <id> --wait`, `/opc:result <id>`, `/opc:task --resume <id>`).
- Nunca corrija, aplique ou continue algo sugerido pelo resultado sem o usuário pedir. Nunca inicie outro job do opc por conta própria a partir de um resultado.
- Informe que um job com falha (exit `7`) falhou e mostre sua linha de erro. Não refaça a tarefa por conta própria.

## Solicitações pendentes (exit code 3)

Um job em `waiting_permission` imprimiu uma ou mais solicitações (permissões `per_…`, perguntas `que_…`). O worker mantém o turno ativo até alguém decidir ou até `policy.permissionTimeoutSec` expirar; então o opc rejeita com "opc: nenhum aprovador disponível".

1. Mostre cada solicitação exatamente como impressa: ferramenta, padrões, sessão (sessões-filhas são identificadas) e job.
2. Consulte o aprovador: `opc config get policy.approver --json` (se ausente, use `user`).
3. Aprovador `user` (padrão):
   - use AskUserQuestion com as opções "Permitir uma vez" e "Rejeitar" (inclua o campo de motivo para rejeitar);
   - permitir uma vez → `/opc:permissions reply <id> once --confirmed-by-user`;
   - rejeitar → `/opc:permissions reply <id> reject "<valor>"`.
4. Aprovador `claude`: você pode responder `once` ou `reject`, exceto quando a solicitação disser "Exige o usuário: sim" (comando destrutivo, diretório externo ou caminho sensível). Esses casos sempre devem ser encaminhados ao usuário como no passo 3.
5. Perguntas: faça cada pergunta ao usuário com AskUserQuestion (mesmas opções e rótulos; texto livre apenas quando a pergunta permitir) e envie `/opc:permissions answer <id> "<resposta 1>" "<resposta 2>" …`, usando `|` entre os rótulos de uma resposta de múltipla escolha. Para recusar: `/opc:permissions reply <id> reject`.
6. Após responder, acompanhe o job com `/opc:status <job> --wait`.

## Regras

- Nunca responda `always` (o opc recusa: no OpenCode isso se aplica ao diretório inteiro e sobrepõe as regras da sessão).
- Nunca passe `--confirmed-by-user` sem uma escolha explícita do usuário nesta conversa.
- Rejeitar uma permissão faz o OpenCode rejeitar as outras solicitações pendentes da mesma sessão; a saída as lista.
- Subagentes e workers (`opc-rescue`, `opc-worker`) nunca respondem a permissões: eles devolvem a solicitação ao responsável.
