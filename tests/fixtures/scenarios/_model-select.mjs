// Helper dos cenários da F4a (não é um cenário: o nome começa com "_").
const firstSeen = { key: null };

export function modelKey(body) {
  const m = body?.model;
  return m?.providerID && m?.modelID ? `${m.providerID}/${m.modelID}` : null;
}

// FAKE_FAIL_MODELS="prov/model[,prov/model2]" escolhe quem falha; sem a variável, falha o primeiro modelo visto.
export function isFailingModel(body, env = process.env) {
  const key = modelKey(body);
  if (!key) return false;
  const configured = String(env.FAKE_FAIL_MODELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (configured.length > 0) return configured.includes(key);
  if (firstSeen.key === null) firstSeen.key = key;
  return key === firstSeen.key;
}

export function reviewStructured() {
  return { verdict: 'approve', summary: 'Sem achados relevantes.', findings: [], next_steps: [] };
}

export function successTurn(body) {
  return body?.format
    ? { text: 'Revisão concluída.', structured: reviewStructured(), delayMs: 20 }
    : { text: `resposta falsa de ${modelKey(body)}`, delayMs: 20 };
}
