# Conclave

O conclave consulta vários modelos em paralelo sobre a mesma pergunta e entrega material para
uma síntese: consenso, divergências, posição ponderada pela confiança e recomendação. Os
membros respondem sem se ver, podem debater anonimamente e são identificados somente por
rótulos (`A`, `B`, `C`…). A síntese é feita por um juiz modelo ou pelo Claude.

- Comando no Claude: `/opc:conclave`
- Terminal: `opc conclave`
- Fase de entrega: F4c

## Início rápido

```bash
opc conclave "Devemos guardar a config do CLI em JSON ou TOML?"
opc conclave --models fast,strong,k3 --mode debate --rounds 2 "Vale a pena um write-ahead log aqui?"
opc conclave --mode review --judge strong "Foque em segurança"
```

No Claude, use `/opc:conclave <pergunta> [flags]`. Quando o juiz é Claude, o comando orienta
a aplicar a skill `opc-conclave` para sintetizar a saída por rótulos.

## Modos

| Modo | O que faz | Rodadas |
|---|---|---|
| `opinion` | Cada membro responde à pergunta, às cegas | `conclave.rounds` ou `--rounds`; padrão 1 |
| `debate` | Rodada cega e rodadas posteriores com respostas anônimas dos colegas | Padrão 2; aceita 2 ou 3 |
| `review` | Cada membro revisa o mesmo diff; achados são agrupados | Sempre 1 |

`--rounds` aceita inteiros de 1 a 3. Em `debate`, `--rounds 1` é erro; em `review`, qualquer
valor diferente de 1 é erro de uso (exit 2).

## Composição

- Use `--models a,b,c` (aliases, IDs completos ou nomes curtos do `defaultProvider`) ou `--pool nome` (lista em `conclave.pools`). Sem as duas flags, usa `conclave.defaultPool`. As flags são mutuamente exclusivas.
- Cada membro passa pela política. Entradas negadas, inexistentes, de provider desconectado ou duplicadas são puladas com aviso no stderr (`[opc] aviso: conclave: ignorando ...`).
- São exigidos pelo menos dois membros válidos. Menos que isso retorna exit 2 e lista os motivos; se todos foram negados pela política, retorna exit 4.
- Os membros são embaralhados e recebem rótulos. O mapeamento rótulo → modelo aparece apenas na última seção, **Composição**.
- `--quorum N` ou `conclave.quorum` define o mínimo de respostas válidas por rodada. Deve estar entre 2 e o total de membros válidos.

## Rodadas e anonimização

1. Na primeira rodada, todos recebem a mesma pergunta em sessões próprias, paralelamente até `jobs.maxParallel`, com perfil `read-only`. A resposta segue o schema `conclave-member`: `position`, `confidence`, `key_points`, `risks`, `evidence` e `would_change_mind_if`.
2. Nas rodadas 2 e 3, cada membro continua na mesma sessão e recebe respostas da rodada anterior dos colegas, identificadas por rótulo. A saída também pode incluir `critiques` e `changed`.
3. Antes de uma resposta de membro ou juiz ser repassada a outro membro, ao juiz ou ao pacote de síntese, nomes conhecidos de provider, modelo, família e vendor são substituídos por `[redacted]`. Isso inclui IDs completos ou parciais, nomes de exibição, famílias como `kimi`, `qwen` e `deepseek`, e vendors conhecidos. Palavras genéricas como `flash`, `max`, `pro`, `mini` e `code` não são removidas.

Invariantes e limites:

- Toda string produzida por membro ou juiz é anonimizada antes de `composition`.
- Campos estruturais, a pergunta original e a seção `composition` não são anonimizados.
- A pergunta do usuário segue literal; se ela citar um modelo, essa citação permanece.
- O estilo de escrita não é disfarçado. Uma palavra comum que também seja provider conectado pode ser removida das respostas repassadas.

## Saída estruturada

`conclave.structuredOutput` vale para membros, debate, review e juiz:

| Valor | Comportamento |
|---|---|
| `text` (padrão) | O prompt pede um único objeto JSON numa cerca `json`; o opc o extrai e valida localmente contra o schema |
| `tool` | Envia `format: json_schema` ao OpenCode |

`text` é o padrão porque, no gateway usado pelo projeto, `format: json_schema` retornou
`StructuredOutputError` com `Model did not produce structured output`. Em modo `text`, texto
sem objeto JSON vira `MissingStructuredOutput`; em `tool`, uma falha do protocolo é
`StructuredOutputError`. Um objeto JSON que não atende ao schema vira
`InvalidStructuredOutput` em ambos os modos.

## Quorum e falhas

Um membro é descartado da rodada e listado em **Falhas** se o turno falhar, expirar
`conclave.memberTimeoutSec`, retornar `StructuredOutputError`, `MissingStructuredOutput`,
`InvalidStructuredOutput` ou, numa rodada posterior, `MissingSession`. O texto bruto de uma
falha de saída estruturada pode aparecer em `rawText`, limitado a 4 KB. Não há fallback de
modelo para membros; o membro descartado não retorna nas rodadas seguintes.

Se uma rodada tiver menos respostas válidas que o quorum, o grupo termina `failed` com exit 7,
sem juiz, preservando respostas parciais e falhas. Um cancelamento termina com exit 130.

## Síntese

| Juiz | Como funciona |
|---|---|
| `claude` (padrão) | O pacote inclui `synthesisInput` com respostas anonimizadas por rótulo; a skill `opc-conclave` produz a síntese sem viés de marca |
| `<modelo>` | Uma sessão `read-only` recebe `conclave-judge.md` e o schema `conclave-synthesis`; vê somente rótulos |

Um juiz que também é membro exige `--allow-judge-member`. O juiz modelo passa pela política;
negação retorna exit 4. Se ele falhar, o conclave continua `completed`, registra aviso e o
Claude pode sintetizar a partir de `synthesisInput`.

O schema `conclave-synthesis` contém `consensus[]`, `disagreements`, `weighted_position`,
`confidence`, `recommendation` e `minority_reports`.

## Modo review

O opc coleta o diff uma vez, seguindo a regra de `/opc:review` para `--base`, `--scope`,
staged, unstaged e untracked, e envia o mesmo contexto e schema `review-output` a cada membro.
A pergunta é opcional e vira o foco do review.

Achados entram no mesmo cluster quando estão no mesmo arquivo normalizado, suas linhas se
sobrepõem ou ficam a até três linhas de distância, e os títulos têm similaridade Jaccard de
tokens de pelo menos `0.3`. Achados sem arquivo não são agrupados. O cluster usa a maior
severidade, concordância `k/N`, confiança média, rótulos e o achado de maior confiança.

O veredito é `needs-attention` se houver cluster `high` ou `critical` com concordância de pelo
menos 2, ou se mais da metade dos membros válidos retornar `needs-attention`; caso contrário é
`approve`. `needs-attention` ainda retorna exit 0. O conclave não corrige o diff.

## Jobs, saída e acompanhamento

O conclave cria um job-grupo `conc-…`, com jobs de membros `member:<rótulo>` e, quando houver
juiz modelo, `judge`. Um único worker coordenador usa uma conexão SSE compartilhada. O grupo
ocupa uma vaga de `jobs.maxActive`; membros e juiz não ocupam vagas extras. Os turnos simultâneos
respeitam `jobs.maxParallel`.

`--background` devolve o id imediatamente. Acompanhe com `/opc:status <id>` e consulte
`/opc:result <id>`; com `--json`, o resultado é `{ group, members }` e o pacote está em
`group.result`. `--wait-timeout` retorna exit 6, mas o grupo continua em background.

Cancelar o grupo cancela seus membros. Cancelar um membro aborta apenas sua sessão e o quorum
decide o resultado. Se o cancelamento chega enquanto uma sessão de membro ou juiz ainda está
sendo criada, ele fica pendente, é conferido antes do prompt e a sessão recém-criada é abortada.

Em Markdown, a saída contém cabeçalho, falha/avisos, pergunta, respostas ou clusters, síntese e
**Composição** por último. Em `--json`, os principais campos são:

| Campo | Conteúdo |
|---|---|
| `jobId`, `schemaVersion`, `kind`, `status`, `failure` | Identificação e resultado; a falha pode ser `QUORUM_NOT_MET` ou `REVIEW_CONTEXT_FAILED` |
| `mode`, `question`, `rounds`, `quorum` | Parâmetros efetivos |
| `warnings`, `failures`, `roundsData`, `final` | Avisos, falhas e respostas por rodada |
| `review`, `judge`, `synthesisInput` | Dados do review e da síntese; `synthesisInput` é `null` se o grupo falhou |
| `composition` | Mapeamento rótulo → modelo, sempre o último campo |

## Configuração e custo

```json
{
  "conclave": {
    "pools": { "default": ["fast", "strong", "k3"], "duo": ["fast", "strong"] },
    "defaultPool": "default",
    "judge": "claude",
    "rounds": 1,
    "quorum": 2,
    "memberTimeoutSec": 900,
    "structuredOutput": "text"
  }
}
```

Veja cada chave em [configuration.md](configuration.md#conclave). O `.opc.json` pode
sobrescrever preferências permitidas, mas toda escolha de modelo ainda passa pela política.
O custo aproximado é `membros × rodadas` turnos, mais um turno de juiz modelo.

## Exit codes

| Código | Quando |
|---|---|
| 0 | Conclave concluído, inclusive review `needs-attention` ou falha do juiz modelo |
| 2 | Composição, flags, modo, rodadas ou quorum inválidos |
| 4 | Todos os membros negados, juiz negado ou `OPC_INSIDE_SERVER=1` |
| 5 | Servidor OpenCode indisponível |
| 6 | `--wait-timeout` expirou e o grupo continua |
| 7 | Quorum não atingido ou falha ao coletar o diff |
| 130 | Conclave cancelado |

## Exemplos executados

Saídas reais do portão da F4c (redigidas: caminhos pessoais trocados por `~`).

### Opinião com três modelos

```bash
opc conclave --models omniroute-personal/opencode-go/deepseek-v4.1-flash,omniroute-personal/opencode-go/qwen3.8-max,omniroute-personal/opencode-go/kimi-k3 "Para um CLI Node.js sem dependências, a config do usuário deve ficar em JSON ou TOML?"
```

<!-- F4C-LIVE-OUTPUT: opinion -->

### Debate de duas rodadas com juiz modelo

```bash
opc conclave --models omniroute-personal/opencode-go/deepseek-v4.1-flash,omniroute-personal/opencode-go/qwen3.8-max --mode debate --rounds 2 --judge omniroute-personal/opencode-go/kimi-k3 "Para um CLI Node.js sem dependências, a config do usuário deve ficar em JSON ou TOML?"
```

<!-- F4C-LIVE-OUTPUT: debate -->

### Review cruzado

```bash
opc conclave --models omniroute-personal/opencode-go/deepseek-v4.1-flash,omniroute-personal/opencode-go/qwen3.8-max,omniroute-personal/opencode-go/kimi-k3 --mode review "Foque em correção e segurança"
```

<!-- F4C-LIVE-OUTPUT: review -->

## Solução de problemas

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Menos de 2 membros válidos | Entradas negadas, inexistentes, desconectadas ou duplicadas | Leia os avisos no stderr e ajuste `--models` ou a pool |
| Exit 7 com `QUORUM_NOT_MET` | Falhas ou timeout reduziram as respostas válidas | Veja **Falhas**, ajuste `conclave.memberTimeoutSec` ou os membros |
| `MissingStructuredOutput` em `text` | A resposta não trouxe um objeto JSON extraível | Mantenha `text`, reformule a tarefa ou troque o membro |
| `StructuredOutputError` em `tool` | O gateway não produziu a saída do protocolo | Use `conclave.structuredOutput text` ou outro ambiente compatível |
| `InvalidStructuredOutput` | O JSON existe, mas não satisfaz o schema | Troque o membro ou reformule o pedido |
| `MissingSession` | Uma rodada posterior não recebeu a sessão da anterior | Execute novamente; se persistir, preserve as falhas e investigue o servidor |
| Juiz falhou | O turno do juiz modelo falhou | Use a skill `opc-conclave` com `synthesisInput` ou escolha outro juiz |
| `[redacted]` na resposta | Anonimização de modelo, vendor ou provider | Esperado; consulte a composição apenas no fim |
