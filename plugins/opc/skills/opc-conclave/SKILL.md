---
name: opc-conclave
description: Como sintetizar o resultado de um conclave do opc (/opc:conclave) — consenso, divergências, posição ponderada pela confiança e recomendação — sem viés de marca de modelo. Use sempre que a saída de `opc conclave` ou `opc result <conc-id>` pedir síntese pelo Claude, ou para conferir a síntese de um juiz modelo.
---

# Síntese de conclave

Um conclave junta respostas independentes de vários modelos, identificadas só por rótulos (`A`, `B`, `C`…). Sua tarefa é transformar essas respostas numa síntese útil, fiel ao que foi dito e imune à marca de quem disse.

## Regra de ouro: rótulos antes de marcas

- Leia e pese as respostas **somente pelos rótulos**. A tabela "Composição" (rótulo → modelo) fica no fim da saída de propósito: não a consulte antes de terminar a síntese.
- Nunca dê mais ou menos peso a uma resposta por causa do modelo, do vendor ou do provider que a produziu, nem por reputação ou tamanho do modelo. O peso vem de argumento, evidência e confiança declarada.
- Não especule sobre qual modelo escreveu qual resposta e não comente estilo de marca ("isso parece coisa do modelo X").
- Trechos `[redacted]` são nomes removidos pelo opc. Não tente reconstruí-los.
- Na resposta final, a composição aparece só numa seção "Composição" no fim, copiada da saída, sem adjetivos sobre os modelos.

## Como sintetizar

1. **Quorum e falhas primeiro.** Diga quantas respostas válidas houve, de quantos membros, e liste as falhas (rótulo, rodada, tipo). Se o status for `falhou` (quorum não atingido), não apresente consenso: mostre as respostas parciais como parciais.
2. **Consenso.** Afirmações sustentadas pela maioria dos membros válidos, em linguagem neutra. Diga "A, B e C concordam que…". Concordância genérica ("depende") não conta como consenso.
3. **Divergências.** Para cada ponto em disputa: o tópico, cada posição e os rótulos que a sustentam. Prefira poucos tópicos reais a muitos tópicos cosméticos.
4. **Posição ponderada.** Pondere cada posição pela confiança declarada (`confidence`, 0 a 1) **e** pela qualidade da evidência:
   - evidência com `arquivo:linha` que você conferiu vale mais que afirmação solta; quando for barato, leia o arquivo citado para confirmar;
   - evidência inventada ou errada derruba o peso daquela resposta, e isso deve ser dito;
   - uma resposta bem fundamentada pode vencer várias sem fundamento: diga quando isso acontecer, em vez de contar votos.
5. **Confiança da síntese.** Dê a sua confiança (baixa/média/alta, ou um número de 0 a 1) e o motivo: dispersão das posições, qualidade da evidência, falhas de membros.
6. **Recomendação.** O que o usuário deve fazer agora, concreto e acionável. Se a resposta honesta for "precisa de mais informação", diga qual informação.
7. **Relatórios minoritários.** Posições que perderam mas são bem argumentadas e mudariam a decisão se um fato se confirmar (use `would_change_mind_if` dos membros).

## Debate (rodadas 2 e 3)

- Use as respostas da **última rodada** como posição final de cada membro.
- `changed: true` indica que o membro mudou de posição. Diga quem mudou e por qual argumento (veja as `critiques` dirigidas a ele). Mudança por bom argumento reforça a posição de destino; mudança sem motivo claro, não.

## Juiz modelo

Quando a síntese veio de um juiz modelo, confira-a contra as respostas brutas: consenso que não existe, divergência omitida, posição ponderada sem base ou minoria importante esquecida. Apresente a síntese do juiz com as correções apontadas. Se o juiz falhou, faça a síntese você mesmo a partir das respostas.

## Modo review

- Apresente o veredito do conclave e os motivos (cluster severo com concordância ≥ 2, ou maioria de `needs-attention`).
- Liste os clusters por severidade com `k/N` (N = membros válidos) e `arquivo:linhas`. Concordância alta aumenta a prioridade; um achado `1/N` pode ser real, então verifique o código antes de descartá-lo.
- Achados sem arquivo aparecem isolados; trate-os como observações gerais.
- **Não corrija nada.** Pergunte ao usuário quais achados tratar.

## Formato da resposta

```
## Conclave: <pergunta resumida>
Quorum: <válidos>/<membros> · Rodadas: <n> · Falhas: <lista ou "nenhuma">

### Consenso
### Divergências
### Posição ponderada (confiança: …)
### Recomendação
### Relatórios minoritários
### Composição
| Rótulo | Modelo |
```
