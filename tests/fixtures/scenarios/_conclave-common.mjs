// Shared behavior for the conclave scenarios (not a scenario by itself).
// Every scenario decides per request: member (round 1), debate (rounds 2..N), judge or review,
// using the json_schema title sent by the plugin and the model family in body.model.modelID.

export const HANG = Symbol('hang');

export function textOf(body) {
  return (body?.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
}

export function kindOf(body) {
  const prompt = textOf(body);
  const embeddedTitle = prompt.match(/"title"\s*:\s*"([^"]+)"/)?.[1];
  const title = body?.format?.schema?.title ?? embeddedTitle ?? null;
  if (title === 'ConclaveMember') return 'member';
  if (title === 'ConclaveDebate') return 'debate';
  if (title === 'ConclaveSynthesis') return 'judge';
  return 'review';
}

export function familyOf(body) {
  const id = String(body?.model?.modelID ?? '').toLowerCase();
  for (const family of ['deepseek', 'qwen', 'kimi']) if (id.includes(family)) return family;
  return 'other';
}

export function tagList(text, tag) {
  const m = text.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

const POSITIONS = {
  deepseek: { position: 'Add a write-ahead log before applying changes.', confidence: 0.8 },
  qwen: { position: 'Apply changes in place and rely on nightly backups.', confidence: 0.6 },
  kimi: { position: 'Add a write-ahead log, but batch fsync calls.', confidence: 0.7 },
  other: { position: 'Measure first, then decide.', confidence: 0.5 },
};

export function memberAnswer(family, overrides = {}) {
  const base = POSITIONS[family] ?? POSITIONS.other;
  return {
    position: base.position,
    confidence: base.confidence,
    key_points: ['Durability matters more than raw latency here.'],
    risks: ['More disk writes per change.'],
    evidence: [{ file: 'src/store.js', line_start: 10, line_end: 20, note: 'writes happen in place' }],
    would_change_mind_if: 'Benchmarks show the log doubles write latency.',
    ...overrides,
  };
}

export function debateAnswer(family, body, { changed = false, overrides = {} } = {}) {
  const peers = tagList(textOf(body), 'peer_labels');
  return {
    ...memberAnswer(family),
    ...(changed ? { position: 'After the debate: add a write-ahead log with batched fsync.', confidence: 0.75 } : {}),
    critiques: peers.slice(0, 1).map((target) => ({ target, point: 'The latency argument has no numbers behind it.' })),
    changed,
    ...overrides,
  };
}

export function synthesisFor(body) {
  const labels = tagList(textOf(body), 'labels');
  return {
    consensus: ['Durability is the main concern.'],
    disagreements: [{ topic: 'How to guarantee durability', positions: [{ members: labels.slice(0, 1), stance: 'write-ahead log' }, { members: labels.slice(1), stance: 'in-place writes plus backups' }] }],
    weighted_position: 'Add a write-ahead log.', confidence: 0.7,
    recommendation: 'Prototype the log and measure write latency.',
    minority_reports: [{ members: labels.slice(-1), summary: 'Backups may be enough for low write volume.' }],
  };
}

export function reviewAnswer() {
  return { verdict: 'approve', summary: 'No material issues.', findings: [], next_steps: [] };
}

export const STRUCTURED_ERROR = { name: 'StructuredOutputError', data: { message: 'Model did not produce valid structured output', retries: 2 } };

const DEFAULTS = {
  member: ({ family }) => ({ structured: memberAnswer(family) }),
  debate: ({ family, body }) => ({ structured: debateAnswer(family, body) }),
  judge: ({ body }) => ({ structured: synthesisFor(body) }),
  review: () => ({ structured: reviewAnswer() }),
};

export function makeConclaveScenario(handlers = {}) {
  return {
    onPromptAsync(fake, sessionID, body) {
      const kind = kindOf(body);
      const handler = handlers[kind] ?? DEFAULTS[kind];
      const outcome = handler({ fake, sessionID, body, family: familyOf(body) });
      if (outcome === HANG) return;
      const turn = { delayMs: 20, text: '', ...outcome };
      if (!body?.format) {
        const structuredError = turn.error?.name === 'StructuredOutputError';
        if (!structuredError && turn.structured !== undefined) {
          turn.text = `\`\`\`json\n${JSON.stringify(turn.structured)}\n\`\`\``;
        }
        delete turn.structured;
        if (structuredError) delete turn.error;
      }
      fake.emitTurn(sessionID, turn);
    },
  };
}
