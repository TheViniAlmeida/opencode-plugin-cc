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
3. Antes de uma resposta de membro ou juiz ser repassada a outro membro, ao juiz ou ao pacote de síntese, nomes conhecidos de provider, modelo, família e vendor são substituídos por `[redacted]`, inclusive em caminhos de `file` citados pelos modelos. As fontes são:
   - dos membros e do juiz: o id completo, os segmentos do id do modelo e as famílias derivadas deles (`kimi`, `qwen`, `deepseek`, com sufixo de versão como `qwen3.7-flash`);
   - do catálogo inteiro: só identificadores específicos, como ids completos, ids com namespace e ids de provider com 4 ou mais caracteres; um token isolado conta apenas se mistura letras e dígitos (`k2.6`, `r1`) ou pertence à lista curada de famílias e vendors (`openai`, `anthropic`, `alibaba`, `moonshot`, entre outros);
   - nomes de exibição, só como frase inteira, nunca palavra por palavra.

   O id de provider nomeia a rota ou o gateway, não o modelo: o id completo (`omniroute-personal`) sai sempre, mas suas palavras (`personal`) só contam quando são específicas. Palavras genéricas (`flash`, `max`, `pro`, `mini`, `code`, `cmd`), números, versões e tokens de código (`18`, `v0`, `e2e`, `utf8`, `NaN`) não são removidos, exceto quando são tokens do id do próprio membro ou juiz (um membro em `v0` não pode dizer `v0`).

Invariantes e limites:

- Toda string produzida por membro ou juiz é anonimizada antes de `composition`.
- Campos estruturais, a pergunta original e a seção `composition` não são anonimizados.
- A pergunta do usuário segue literal; se ela citar um modelo, essa citação permanece.
- O estilo de escrita não é disfarçado. Um id de provider conectado com 4 ou mais caracteres que também seja palavra comum ainda pode ser removido.
- A substituição é feita numa única passada: um nome entre colchetes (`[Qwen]`) vira um único `[redacted]`.

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

Alguns modelos devolvem os valores no formato do schema. O opc aceita dois casos, e só quando o
resultado valida: valores dentro de `properties` (`{"title": …, "properties": {…}}`) e palavras-chave
do schema (`$schema`, `$id`, `title`, `type`, `description`) ao lado dos valores. O texto bruto do
turno não é alterado. No review em modo `tool`, o prompt da F2b pede cerca `json`; o conclave
acrescenta uma instrução explícita que substitui essa parte pela saída estruturada.

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

Saídas reais do portão da F4c, sem edição além do id do provider pessoal, que aparece como `omniroute-personal`. As rotas `cmd/*` são as do gateway usado no portão; troque pelos modelos do seu catálogo (`opc models`).

### Opinião com três modelos

```bash
opc conclave --models omniroute-personal/cmd/deepseek/deepseek-v4-flash,omniroute-personal/cmd/Qwen/Qwen3.7-Flash,omniroute-personal/cmd/moonshotai/Kimi-K2.6 "Para um CLI Node.js sem dependências, a config do usuário deve ficar em JSON ou TOML?"
```

<details>
<summary>Saída real (opinião, 30/09/2026, OpenCode 1.18.32)</summary>

````markdown
# opc conclave · opinion

**Status:** concluído · **Rodadas:** 1/1 · **Quorum:** 2 · **Válidos:** 3/3 · **Duração:** 1 min 19 s · **Job:** `conc-muo5ypc9-6uqci3`

## Pergunta

> Para um CLI Node.js sem dependências, a config do usuário deve ficar em JSON ou TOML?

## Respostas (rodada 1)

### Membro A · confiança 0.85

**Posição:**

```
TOML
```

**Pontos-chave:**
- Comentários: TOML permite comentários com #; JSON não. Config de usuário quase sempre precisa de comentários (explicação, desativação temporária, contexto).
- Ergonomia de leitura/edição: chaves plano e hierarquia visual clara (`[database] host = "localhost"`) é mais acessível para usuários finais que objetos JSON aninhados com chaves entre aspas e colchetes.
- Ecossistema de referência: Rust (Cargo.toml), Deno (deno.jsonc ainda usa JSON por restrições do runtime, mas o movimento geral é TOML para config), pip (pyproject.toml), uv — ferramentas modernas preferem TOML justamente quando a configurabilidade do usuário importa.
- Parsing em Node.js: pacote `toml` (~6 KB minified) é pequeno e maduro; a economia de "zero dependências" raramente justifica pior experiência do usuário final em CLI distribuído via npm.

**Riscos:**
- Se o projeto leva "zero dependências" literalmente como requisito irrevogável, TOML exige um parser externo — JSON é nativo via JSON.parse().
- Usuário pode já ter config existente em JSON e tentar fazer `require('./config.json')`; TOML força consciência explícita do formato.
- Validação estrutural: JSON tem JSON Schema maduro; TOML em Node.js depende de validação manual ou bibliotecas extras.

**Mudaria de ideia se:**

```
O projeto impuser uma restrição documentada de tamanho absoluto (ex: binary < 200 KB ou cold-start sob 50 ms) onde 6 KB de pacote TOML seria decisivo, OU o público-alvo fossem exclusivamente desenvolvedores já imersos em ecossistema TypeScript/Node que esperam JSON.
```

### Membro B · confiança 0.78

**Posição:**

```
JSON. With a hard 'no dependencies' constraint, JSON wins because it is the only config format Node parses natively (JSON.parse/JSON.stringify in the standard library). TOML has no built-in parser in Node, so choosing TOML forces either a dependency or a hand-rolled parser — which directly contradicts the stated constraint. Default to a JSON file (e.g. ~/.mycli/config.json, optionally also reading package.json-style config); only reach for TOML after deciding the zero-dep rule is negotiable.
```

**Pontos-chave:**
- Node has no standard-library TOML parser. JSON.parse is built in; every zero-dep CLI already needs JSON handling for package.json anyway, so the parser cost is zero and the code is idiomatic.
- 'No dependencies' is the deciding constraint in the question; it converts the general ergonomics debate (TOML reads better for humans) into a single hard fact — TOML would require a parser you must vendor or write.
- JSON's weaknesses (no comments, no trailing commas, quoting) matter most for heavily hand-edited files; for a machine-written CLI config with occasional edits, they are tolerable and error messages are clear via JSON.parse.
- If hand-editability is later judged essential, prefer JSON-with-comments via a well-known key (e.g. "_comment") or YAML/TOML only after relaxing zero-dep — do not hand-roll a TOML parser, since partial TOML implementations fail on edge cases (multiline strings, dates, arrays of tables).
- Precedent: the dominant Node CLI ecosystem (and package.json itself) uses JSON, so users already expect it and editor/tooling support is universal.

**Riscos:**
- JSON cannot carry comments and rejects trailing commas, which is a real DX regression for users who hand-edit the config; this can generate support noise.
- Silent partial parses or lost data are not a risk with JSON.parse (it throws), but a hand-rolled TOML fallback WOULD risk subtle parse divergence — a caution against the middle path.
- If the CLI is part of a polyglot toolchain where TOML is the house standard (Rust/Python tooling), picking JSON creates inconsistency; in that case the zero-dep rule, not the format, should be revisited.

**Mudaria de ideia se:**

```
If the project's primary constraint were actually readability/hand-editing of a rich config (nested tables, comments, dates) rather than zero dependencies, or if the surrounding toolchain already standardizes on TOML — then TOML becomes the right call and the zero-dep rule should be relaxed to allow a parser. I would also switch if Node shipped a TOML parser in the standard library.
```

### Membro C · confiança 0.92

**Posição:**

```
JSON
```

**Pontos-chave:**
- Node.js possui suporte nativo a JSON sem dependências — JSON.parse e require('./file.json') são built-in desde as primeiras versões
- TOML exigiria um parser externo (quebrando a premissa 'sem dependências') ou um parser customizado (custo de manutenção e risco de bugs)
- JSON é o formato de facto da comunidade Node.js — package.json, tsconfig.json, .eslintrc.json provam adoção massiva
- A curva de aprendizado é zero para qualquer desenvolvedor Node.js; TOML introduziria fricção desnecessária
- Ferramentas do ecossistema (npm, yarn, pnpm, volta, nvm) já padronizam expectativa do usuário em torno de JSON para configuração

**Riscos:**
- JSON não suporta comentários nativamente, dificultando documentação inline em arquivos de configuração
- Ausência de trailing commas em versões mais antigas do Node.js pode gerar erros de sintaxe silenciosos para usuários
- Escapar strings e aninhamento profundo em JSON é verboso e menos legível que TOML para configurações complexas
- Se no futuro o projeto precisar de features avançadas (comentários, tipos de data, tabelas inline), a migração para outro formato pode ser necessária

**Mudaria de ideia se:**

```
Node.js incluísse um parser TOML nativo no módulo 'node:util' ou 'node:fs', eliminando a necessidade de dependências externas; ou se a configuração exigisse extensos comentários inline e legibilidade humana fosse critério absoluto maior que a restrição de zero dependências.
```

## Síntese

Juiz: Claude. Sintetize com a skill `opc-conclave` a partir das respostas acima, só pelos rótulos; a composição está no fim e só entra depois da síntese.

## Composição

| Rótulo | Modelo |
| --- | --- |
| A | omniroute-personal/cmd/Qwen/Qwen3.7-Flash |
| B | omniroute-personal/cmd/deepseek/deepseek-v4-flash |
| C | omniroute-personal/cmd/moonshotai/Kimi-K2.6 |
````

</details>

### Debate de duas rodadas com juiz modelo

```bash
opc conclave --models omniroute-personal/cmd/deepseek/deepseek-v4-flash,omniroute-personal/cmd/Qwen/Qwen3.7-Flash --mode debate --rounds 2 --judge omniroute-personal/cmd/moonshotai/Kimi-K2.6 "Para um CLI Node.js sem dependências, a config do usuário deve ficar em JSON ou TOML?"
```

<details>
<summary>Saída real (debate, 30/09/2026, OpenCode 1.18.32)</summary>

````markdown
# opc conclave · debate

**Status:** concluído · **Rodadas:** 2/2 · **Quorum:** 2 · **Válidos:** 2/2 · **Duração:** 2 min 12 s · **Job:** `conc-muo61073-cigzku`

## Pergunta

> Para um CLI Node.js sem dependências, a config do usuário deve ficar em JSON ou TOML?

## Respostas (rodada 2)

### Membro A · confiança 0.78 · mudou de posição: não

**Posição:**

```
JSON — para um CLI Node.js sem dependências. O fator decisivo continua sendo o parser: JSON.parse/JSON.stringify são nativos, então a restrição 'sem dependências' resolve a questão por si só. Se comentários forem exigidos, a saída sem dependência é um arquivo de config JS (module.exports/export default) ou JSONC tratado explicitamente — nunca TOML, que exigiria parser embutido ou escrito à mão.
```

**Pontos-chave:**
- A restrição 'sem dependências' é o critério dominante: JSON = zero código de parsing/serialização; TOML = dependência ou parser/writer próprios, que passam a ser superfície de manutenção e bug.
- Simetria de round-trip: um CLI que grava a própria config (--init, set) ganha serialização grátis com JSON.stringify; TOML precisaria de writer próprio e preservar comentários/ordem na escrita é difícil.
- Convenção do ecossistema: package.json, tsconfig e a maioria dos CLIs Node usam .json; usuários e ferramentas já esperam isso.
- A única dor real do JSON (comentar) é cosmética e tem escape sem dependência; TOML não é necessário para resolver isso.
- Reafirmo que o problema de comentários é tratado errado pelo peer B (ver critiques): não dá para usar /* */ sem quebrar JSON.parse.

**Riscos:**
- JSON não admite comentários oficialmente; config predominantemente editada à mão vai gerar atrito — mitigar com JSONC ou config JS e documentar.
- Se o ecossistema do projeto já padronizou TOML (config compartilhada com serviço Rust/Python), JSON cria dois formatos concorrentes.
- Um strip de comentários feito sem cuidado (pré-processar antes do JSON.parse) pode introduzir bugs de borda; manter mínimo ou exigir JSON válido.

**Mudaria de ideia se:**

```
Se a config for predominantemente humana e rica em comentários por requisito de produto, ou o projeto já padronizar TOML em outro ponto (config compartilhada com ferramental Rust/Python), ou a estrutura for profundamente aninhada a ponto de a legibilidade do TOML ser requisito explícito — então um parser TOML confiável passaria a valer o custo e eu mudaria (ou iria para config JS se o único motivo fossem comentários).
```

**Críticas:**
- → B: O argumento de comentários em B está factualmente errado e é o ponto que ele usa para anular o único mérito do TOML. JSON não suporta comentários: `JSON.parse('{/* c */"a":1}')` lança SyntaxError — parsers JSON comuns NÃO ignoram `/* */`. Portanto o truque C89 citado não funciona 'sem esforço' e não é uma saída válida para JSON puro; a correção real é JSONC (parser dedicado) ou config JS. Isso reforça a posição de JSON, mas não pela razão que B deu.
- → B: B afirma que o principal mérito do TOML é 'suporte a comentários', o que subestima o argumento real a favor do TOML: estrutura tipada e legível para config aninhada (arrays de tabelas). Como B ainda escolhe JSON, o efeito prático não muda, mas a motivação registrada está incompleta e pode levar a decisões erradas caso a config cresça em profundidade.
- → B: A confiança de B (0.92) é alta demais para uma resposta que contém uma afirmação falsa sobre o comportamento de parsers. A conclusão (JSON) está certa, mas a justificativa tem um erro verificável, então 0.92 não está calibrado.

### Membro B · confiança 0.92 · mudou de posição: não

**Posição:**

```
JSON — é a escolha correta para um CLI Node.js sem dependências.
```

**Pontos-chave:**
- Node.js não possui parser TOML nativo; usar TOML exigiria escrever um parser do zero ou empacotar uma biblioteca, o que viola a restrição 'sem dependências'.
- JSON tem suporte nativo via fs.readFileSync + JSON.parse/stringify — zero custo, zero código extra.
- O principal argumento a favor do TOML (suporte a comentários) pode ser contornado em JSON com o bloco C89 /* ... */ que os parsers comuns ignoram sem esforço.
- JSON é universalmente reconhecido por usuários de qualquer ecossistema; TOML exige familiaridade específica.

**Riscos:**
- Usuários podem se frustrar ao tentar adicionar comentários no JSON (precisam usar o truque /* */ ou aceitar que não há comentários oficiais).
- Se no futuro o CLI precisar migrar para TOML (ex: equipes que operam nas máquinas), haveria custo de migração e mudança de formato.

**Mudaria de ideia se:**

```
Um parser TOML mínimo (≤2 kB minificado) fosse encontrado pronto para copiar-e-colar sem ser registrado como dependência de package.json, ou o projeto passasse a exigir hierarquia complexa (arrays de tabelas aninhadas, exemplos inline) onde TOML se torna significativamente mais legível que JSON para o usuário final.
```

**Críticas:**
- → A: A cita 'round-trip symmetry' como vantagem forte do JSON (JSON.stringify serializa de graça), mas isso reforça meu ponto exatamente: serialize E deserialize são necessários para gravar config (--init, set, edit). Se a restrição é 'sem dependências', TOML precisaria de parser + serializer hand-written — duplicando superfície de bugs. Eu já aludi a isso implicitamente em 'zero código extra'; A tornava explícito o lado da escrita.
- → A: A propõe 'JS config file (module.exports)' como mitigação do problema de comentários no JSON. Isso funciona, mas muda radicalmente a UX: o arquivo deixa de ser puramente declarativo e vira código executável (require/import). Meu argumento era que /* */ mantém o arquivo como JSON válido, sem mudar o modelo mental do usuário. É uma solução diferente, não superior — vale mencionar, mas não invalida escolher JSON puro.

## Síntese

Juiz: `omniroute-personal/cmd/moonshotai/Kimi-K2.6` · confiança 0.93

**Consenso:**

```
A configuração deve usar JSON, não TOML, para um CLI Node.js sem dependências.
A restrição 'sem dependências' é o critério decisivo: JSON.parse e JSON.stringify são nativos do Node.js, enquanto TOML exigiria parser e/ou serializer próprio ou dependência externa.
A capacidade de serializar e desserializar configuração (ex: --init, set, edit) é necessária, e JSON oferece isso sem código adicional.
A convenção do ecossistema Node.js (package.json, tsconfig, etc.) reforça a expectativa dos usuários por arquivos .json.
```

**Divergências:**

```
Validade técnica de comentários no estilo C89 (/* */) dentro de arquivos JSON padrão
A: O truque C89 é factualmente inválido para JSON puro. JSON.parse('{/* c */\"a\":1}') lança SyntaxError; parsers JSON nativos não ignoram /* */, portanto essa não é uma saída sem dependências.
B: Blocos C89 /* */ podem ser usados dentro de arquivos JSON e são ignorados por parsers comuns sem esforço, contornando a falta de comentários oficiais.
```

```
Melhor estratégia de mitigação para a ausência de comentários no JSON
A: As alternativas corretas sem dependências são JSONC (com parser dedicado mínimo) ou um arquivo de configuração JS (module.exports/export default), aceitando que JSON puro não suporta comentários.
B: O truque /* */ mantém o arquivo como JSON do ponto de vista do usuário, sem mudar o modelo mental para código executável, sendo preferível a config JS.
```

```
Calibração de confiança diante de erros verificáveis na justificativa
A: A confiança de B (0.92) está excessivamente alta porque contém uma afirmação verificavelmente falsa sobre o comportamento de JSON.parse, embora a conclusão final (escolher JSON) esteja correta.
B: A justificativa é robusta o suficiente para alta confiança, dado que o critério dominante (zero dependências + parser nativo) é incontestável.
```

**Posição ponderada:**

```
JSON — a restrição 'sem dependências' torna-o a única escolha viável para um CLI Node.js, com TOML descartado pelo custo de manter parser e serializer próprios.
```

**Recomendação:**

```
Use JSON como formato de configuração. Não confie no truque C89 (/* */) para comentários, pois quebra JSON.parse nativo do Node.js. Se comentários forem requisito frequente, prefira (1) JSONC com um parser mínimo embutido, ou (2) um arquivo de configuração JS (module.exports/export default), documentando explicitamente qual formato é aceito e que o arquivo deve ser válido para o parser escolhido.
```

**Relatórios minoritários:**

```
B: Defende que o truque C89 (/* */) é uma solução prática e válida para comentários em JSON, mantendo o modelo mental declarativo do usuário. Essa visão foi contestada por A como tecnicamente incorreta para JSON.parse padrão, mas representa uma abordagem alternativa para mitigar a dor de comentários sem recorrer a JS executável.
A: Sustenta que o mérito real do TOML não é apenas comentários, mas estrutura tipada e legibilidade superior para configurações profundamente aninhadas (arrays de tabelas). Argumenta também que, entre as saídas para comentários sem dependências, config JS é mais robusta que o truque C89 inválido, embora mude a natureza do arquivo para código executável.
```

## Composição

| Rótulo | Modelo |
| --- | --- |
| A | omniroute-personal/cmd/deepseek/deepseek-v4-flash |
| B | omniroute-personal/cmd/Qwen/Qwen3.7-Flash |
````

</details>

### Review cruzado

```bash
opc conclave --models omniroute-personal/cmd/deepseek/deepseek-v4-flash,omniroute-personal/cmd/Qwen/Qwen3.7-Flash,omniroute-personal/cmd/moonshotai/Kimi-K2.6 --mode review "Foque em correção e segurança"
```

<details>
<summary>Saída real (review, 30/09/2026, OpenCode 1.18.32)</summary>

````markdown
# opc conclave · review

**Status:** concluído · **Rodadas:** 1/1 · **Quorum:** 2 · **Válidos:** 3/3 · **Duração:** 42.2 s · **Job:** `conc-muo64fcd-xz3hi5`

## Pergunta

> Foque em correção e segurança

## Veredito: needs-attention

- C1: severidade critical com concordância 2/3
- C3: severidade high com concordância 2/3
- 3 de 3 membros válidos deram needs-attention

Membros válidos: 3

## Achados agrupados

| # | Severidade | Concordância | Confiança média | Local | Título | Rótulos |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | critical | 2/3 | 1 | src/stats.js:9-11 | Injeção de código via eval em entrada de usuário | A, C |
| C2 | critical | 1/3 | 1 | src/stats.js:10-12 | Arbitrary code execution via eval() on untrusted input | B |
| C3 | high | 2/3 | 1 | src/stats.js:3-5 | Off-by-one in average() reads past array bounds, returning NaN | B, C |
| C4 | high | 1/3 | 1 | src/stats.js:3-5 | Erro de limite (off-by-one) no cálculo da média | A |
| C5 | medium | 1/3 | 1 | src/stats.js:2-7 | average() lacks empty-array guard (divides by zero → NaN) | B |
| C6 | medium | 1/3 | 0.9 | src/stats.js:2-7 | Comportamento indefinido ao chamar average com array vazio | A |
| C7 | medium | 1/3 | 0.85 | src/stats.js:1-7 | average não trata array vazio (divisão por zero) | C |
| C8 | low | 1/3 | 0.7 | src/stats.js:1-11 | Ausência de testes para o comportamento introduzido | C |

### C1 · critical · 2/3 · `src/stats.js:9-11`

```
A função runUserFormula recebe uma string arbitrária do usuário e a executa diretamente com eval(). Isso permite execução de código JavaScript arbitrário no contexto do processo, constituindo uma vulnerabilidade crítica de injeção de código (RCE).
```

**Recomendação:** Eliminar o uso de eval(). Se o objetivo é avaliar expressões matemáticas, usar uma biblioteca de sandboxing como math.js ou implementar um parser seguro de expressões aritméticas.

### C2 · critical · 1/3 · `src/stats.js:10-12`

```
runUserFormula() passes the formula string directly to eval(), which executes any JavaScript code. An attacker controlling the formula string can read secrets, exfiltrate data, or modify application state. This is a textbook code-injection vulnerability.
```

**Recomendação:** Remove eval entirely. If the formula needs to be computed, use a sandboxed expression parser (e.g., mathjs evaluate) or precompile it at build time. Reject any formula containing non-math tokens.

### C3 · high · 2/3 · `src/stats.js:3-5`

```
The loop condition is i <= values.length, so when i equals values.length, values[i] is undefined. Adding undefined coerces to NaN, making total become NaN, and the function returns NaN for every non-empty input array instead of the correct average.
```

**Recomendação:** Change the condition to i < values.length. Validate that values is a non-null array before entering the loop.

### C4 · high · 1/3 · `src/stats.js:3-5`

```
O loop de average usa a condição i <= values.length, o que faz com que a última iteração acesse values[values.length], resultando em undefined. A soma de undefined com um número produz NaN, e o retorno final será NaN para qualquer array válido.
```

**Recomendação:** Corrigir a condição do loop para i < values.length.

### C5 · medium · 1/3 · `src/stats.js:2-7`

```
When values has length 0, the division total / values.length yields NaN. No guard or fallback is provided, and callers have no way to distinguish 'empty set' from 'computed result'.
```

**Recomendação:** Return null (or throw) when values.length === 0. Add a guard like if (!Array.isArray(values) || values.length === 0) return null;

### C6 · medium · 1/3 · `src/stats.js:2-7`

```
A função average não trata o caso de values.length === 0, resultando em divisão por zero (Infinity ou NaN dependendo de total).
```

**Recomendação:** Adicionar uma guarda: if (values.length === 0) retornar um valor seguro (ex: 0, NaN documentado, ou lançar erro) em vez de dividir por zero.

### C7 · medium · 1/3 · `src/stats.js:1-7`

```
Quando 'values' é um array vazio, 'total / values.length' resulta em '0 / 0' = NaN. Não há validação de entrada nem comportamento definido (retornar 0, null ou lançar erro) para lista vazia ou argumento não-array.
```

**Recomendação:** Validar a entrada: se não for array, lançar erro explícito; para array vazio, definir contrato (retornar 0/null ou lançar) e cobrir com teste.

### C8 · low · 1/3 · `src/stats.js:1-11`

```
Os dois novos utilitários exportados não acompanham testes. Tanto o off-by-one quanto o caso de array vazio passariam despercebidos e o uso de eval não seria sinalizado.
```

**Recomendação:** Adicionar testes unitários para average (array típico, vazio, entrada inválida) e para runUserFormula, ou remover a função insegura.

## Veredito por membro

| Rótulo | Veredito |
| --- | --- |
| A | needs-attention |
| B | needs-attention |
| C | needs-attention |

## Síntese

Juiz: Claude. Sintetize com a skill `opc-conclave` a partir das respostas acima, só pelos rótulos; a composição está no fim e só entra depois da síntese.

## Composição

| Rótulo | Modelo |
| --- | --- |
| A | omniroute-personal/cmd/moonshotai/Kimi-K2.6 |
| B | omniroute-personal/cmd/Qwen/Qwen3.7-Flash |
| C | omniroute-personal/cmd/deepseek/deepseek-v4-flash |
````

</details>

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
