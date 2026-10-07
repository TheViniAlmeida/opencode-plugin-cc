// Pure adapters from OpenCode 2.0.22 responses to opc's internal request shapes.
const NATIVE_AGENTS = new Set(['build', 'plan', 'general', 'explore']);

export function toAgent(agent) {
  return {
    name: agent.id,
    description: agent.description ?? null,
    mode: agent.mode,
    native: NATIVE_AGENTS.has(agent.id),
    hidden: Boolean(agent.hidden),
    model: agent.model?.providerID && (agent.model.modelID ?? agent.model.id)
      ? { providerID: agent.model.providerID, modelID: agent.model.modelID ?? agent.model.id } : null,
    variant: agent.variant ?? null,
    permissions: agent.permissions ?? [],
  };
}

export function toPermissionRequest(v2) {
  return {
    id: v2.id,
    sessionID: v2.sessionID,
    permission: v2.action,
    patterns: v2.resources ?? [],
    metadata: { command: v2.action === 'shell' ? v2.resources?.[0] : undefined, save: v2.save ?? [] },
    source: v2.source ?? null,
  };
}

export function toQuestion(form) {
  if (form.metadata?.kind !== 'question') return null;
  return {
    id: form.id,
    sessionID: form.sessionID,
    questions: form.fields.map((field) => ({
      key: field.key,
      header: field.title ?? '',
      question: field.description ?? field.title ?? '',
      options: (field.options ?? []).map((option) => ({ label: option.label ?? String(option.value), value: option.value })),
      multiple: field.type === 'multiselect',
      custom: field.custom === true,
    })),
  };
}

export function toFormAnswer(question, answers) {
  return {
    answer: Object.fromEntries(question.questions.map((field, index) => {
      const values = answers[index].map((answer) => field.options.find((option) => option.label === answer)?.value ?? answer);
      return [field.key, field.multiple ? values : values[0]];
    })),
  };
}

export function toSessionStatus(active) {
  return Object.fromEntries(Object.keys(active).map((sessionID) => [sessionID, { type: 'busy' }]));
}
