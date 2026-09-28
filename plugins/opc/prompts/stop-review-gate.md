<!-- Adapted from openai/codex-plugin-cc (Apache-2.0); modified -->
<task>
Faça uma revisão de bloqueio da resposta anterior do Claude.
Revise somente o trabalho da resposta anterior do Claude.
Revise-o apenas se Claude realmente fez alterações de código nessa resposta.
Saídas apenas de status, configuração ou relatório não contam como trabalho revisável.
Por exemplo, a saída de /opc:setup, /opc:status ou /opc:review não deve ser revisada.
Somente edições diretas feitas naquela resposta específica contam.
Se a resposta anterior do Claude foi apenas uma atualização de status, resumo, verificação de configuração, resultado de revisão ou saída de um comando que não fez edições diretas nessa resposta, retorne ALLOW imediatamente e não investigue mais.
Avalie se aquele trabalho específico e suas decisões de projeto devem ser entregues.

O contexto do repositório representa toda a árvore de trabalho: o diff pode incluir alterações não commitadas anteriores e não inclui alterações já commitadas. Atribua à resposta anterior somente as edições que o bloco de transcrição mostra que Claude fez. Se não tiver certeza de que uma alteração pertence à resposta anterior, não bloqueie por ela.

{{CLAUDE_RESPONSE_BLOCK}}
</task>

{{PROJECT_CONTEXT}}

<repository_context>
{{REPOSITORY_CONTEXT}}
</repository_context>

<compact_output_contract>
Retorne uma resposta final concisa.
A primeira linha deve ser exatamente uma destas opções:
- ALLOW: <motivo breve>
- BLOCK: <motivo breve>
Não coloque nada antes dessa primeira linha.
</compact_output_contract>

<default_follow_through_policy>
Use ALLOW se a resposta anterior não fez alterações de código ou se você não encontrou um problema bloqueador.
Use ALLOW imediatamente, sem investigação adicional, se a resposta anterior não produziu edições.
Use BLOCK somente se a resposta anterior fez alterações de código e você encontrou algo que ainda precisa ser corrigido antes de encerrar.
</default_follow_through_policy>

<grounding_rules>
Fundamente cada alegação de bloqueio no contexto do repositório acima ou em arquivos lidos com as ferramentas read, glob ou list (grep não está disponível). Você não pode executar comandos.
Não trate a resposta anterior do Claude como prova de que houve alterações; verifique isso no contexto do repositório antes de bloquear.
Não bloqueie por alterações antigas quando a resposta imediatamente anterior não fez edições diretas.
</grounding_rules>

<dig_deeper_nudge>
Se a resposta anterior fez alterações de código, verifique falhas de segunda ordem, estados vazios, novas tentativas, estado obsoleto, risco de reversão e decisões de projeto antes de concluir.
</dig_deeper_nudge>
