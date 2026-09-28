---
name: opc-prompting
description: Orientação interna para compor prompts enviados aos modelos OpenCode por meio do plugin opc em tarefas de código, diagnóstico, revisão e pesquisa
user-invocable: false
---

# Como escrever prompts para modelos OpenCode pelo opc

Use esta skill ao preparar o texto enviado por `opc task`, `opc ask` ou `opc plan` a um modelo OpenCode, por exemplo dentro de `opc:opc-rescue` antes de sua única chamada `task`.

Prompts enviados ao OpenCode devem ser escritos em inglês. Todo texto fornecido pelo usuário — tarefa, foco, citações e código — deve ser passado literalmente no idioma original, sem tradução ou reformulação.

Os modelos usados pelo OpenCode variam bastante em janela de contexto, disciplina no uso de ferramentas e seguimento de instruções; a rota também pode recorrer a outro modelo. Escreva prompts que funcionem com o modelo mais limitado da rota, não apenas com o mais capaz.

## Princípios

1. Um trabalho por execução. Separe pedidos sem relação; encadeie com `--resume-last` somente quando o segundo depender do primeiro.
2. Comece pelo resultado. A primeira linha define o que significa concluir: um patch que faz um teste nomeado passar, uma causa raiz com evidências ou um plano ordenado.
3. Dê referências, não uma narrativa longa. Nomeie arquivos, símbolos, comandos, mensagens de erro e passos para reproduzir. Inclua as linhas exatas do erro em vez de parafraseá-las.
4. Declare os limites. Indique quais arquivos podem mudar e quais não podem, se novas dependências são permitidas (por padrão, não) e que refatorações sem relação estão fora de escopo.
5. Peça evidências. Afirmações devem citar `caminho:linha`; inferências devem ser identificadas como inferências.
6. Defina o formato da resposta. Uma estrutura curta e fixa ajuda modelos menores mais do que um pedido aberto.
7. Seja breve. Omita contexto que o modelo pode ler no repositório; prompts longos diluem as instruções importantes.

## Estrutura sugerida

Títulos Markdown simples funcionam com os modelos e provedores:

```text
Goal: <one sentence describing the desired outcome>

Context:
- <file or symbol> — <why it matters>
- Error: <exact message or failing test name>

Constraints:
- Change only <paths>. Add no dependencies. Avoid unrelated refactors.
- <applicable project rule, for example: keep the public API unchanged>

Done when:
- <observable check, for example: npm test -- tests/unit/foo.test.mjs passes>

Answer with:
1. What changed or was found (with path:line)
2. How you verified it
3. Open questions or risks
```

## Padrões de tarefa

- Correção: descreva o comportamento com falha, como reproduzi-lo, o comportamento esperado e o comando de verificação. Peça a menor mudança que resolva o problema e a saída da verificação.
- Diagnóstico sem edição: diga explicitamente “não edite arquivos”, remova `--write` e peça a causa raiz, a cadeia de evidências e uma correção recomendada.
- Pergunta sobre o código: prefira `/opc:ask`; peça primeiro uma resposta direta e depois referências `caminho:linha` que a sustentem.
- Planejamento: prefira `/opc:plan`; peça arquivos afetados, ordem do trabalho, alternativas, riscos e testes.
- Revisão de mudanças locais: use `/opc:review` ou `/opc:adversarial-review`; os prompts já incluem o contrato de revisão e o formato estruturado.

## Continuação com --resume-last

- Envie somente a diferença, como “agora aplique o segundo achado” ou “inclua também o caso de lista vazia”. A sessão já contém o contexto anterior.
- Repita as restrições somente se elas mudarem.
- Inicie outra sessão com `--fresh` quando a direção mudar ou a sessão anterior tiver se desviado.

## Escolha de opções

- Use `--write` somente quando o usuário pedir edições; pedidos de planejamento, análise e revisão nunca usam `--write`.
- Use `--variant` (alias `--effort`) somente quando o usuário pedir mais ou menos raciocínio; os valores aceitos dependem do modelo (`/opc:models --verbose`).
- Use `--agent` somente quando o usuário nomear um agente OpenCode; ele precisa ser permitido pela política do opc.
- Deixe `--model` sem valor, a menos que o usuário peça; o roteamento escolhe o modelo para a tarefa.

## Antipadrões

- Vários pedidos sem relação na mesma execução.
- “Corrija tudo que encontrar” sem limites claros.
- Erros parafraseados em vez das mensagens exatas.
- Pedir ao modelo comandos destrutivos; eles sempre geram solicitações de permissão para o usuário.
- Colar arquivos grandes que o modelo pode ler com suas ferramentas.
