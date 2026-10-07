// Shared behaviour of the F4b fake scenarios. Runs inside the fake OpenCode process.
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export function turnLogPath(stateFile = process.env.FAKE_OPENCODE_STATE) {
  return `${stateFile}.turns.jsonl`;
}

export function promptText(body) {
  return body?.text ?? '';
}

// planner = decompose prompt; synthesizer = results block; subtask = <subtask id>.
export function classifyTurn(body) {
  const text = promptText(body);
  if (text.startsWith('You are the planner of a multi-model orchestration run by opc.')) return { role: 'planner', subtaskId: null, text };
  if (text.includes('<orchestration_results>')) return { role: 'synthesizer', subtaskId: null, text };
  const match = text.match(/<subtask id="([^"]+)">/);
  if (match) return { role: 'subtask', subtaskId: match[1], text };
  return { role: 'other', subtaskId: null, text };
}

// Prompts are never logged (they carry user text). Only what the assertions need survives: the prompt length and
// hash, plus dependency/result blocks whose body is exactly a reply this fake emitted itself (`emitted`); any other
// text in a block is dropped, so nothing the user or a model wrote can reach the log.
const FIXTURE_RESULT = String.raw`(RESULT\[[^\]\n]*\] by [^\n]*)`;
const DEPENDENCY_BLOCK = new RegExp(String.raw`<dependency id="([^"]+)">\n${FIXTURE_RESULT}\n</dependency>`, 'g');
const RESULT_BLOCK = new RegExp(String.raw`<result id="([^"]+)" kind="([^"]+)" status="([^"]+)">\n${FIXTURE_RESULT}\n</result>`, 'g');

export function summarizePrompt(text, emitted = new Set()) {
  return {
    promptLength: text.length,
    promptSha256: createHash('sha256').update(text).digest('hex'),
    dependencies: [...text.matchAll(DEPENDENCY_BLOCK)].filter((m) => emitted.has(m[2])).map((m) => ({ id: m[1], result: m[2] })),
    results: [...text.matchAll(RESULT_BLOCK)].filter((m) => emitted.has(m[4])).map((m) => ({ id: m[1], kind: m[2], status: m[3], result: m[4] })),
  };
}

export function makeOrchestrateScenario({ plan = null, plannerText = null, failSubtasks = [], subtaskDelayMs = 300, synthesisText = 'SYNTHESIS-OK: combined answer' } = {}) {
  const emitted = new Set();
  return {
    onPrompt(fake, sessionID, body) {
      const turn = classifyTurn(body);
      const model = fake.state.sessions[sessionID]?.model?.id ?? null;
      const start = Date.now();
      const delay = turn.role === 'subtask' ? subtaskDelayMs : 20;
      setTimeout(async () => {
        if (turn.role === 'planner') {
          await fake.emitTurn(sessionID, { text: plannerText ?? `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` });
        } else if (turn.role === 'synthesizer') {
          await fake.emitTurn(sessionID, { text: synthesisText });
        } else if (turn.role === 'subtask' && failSubtasks.includes(turn.subtaskId)) {
          await fake.emitTurn(sessionID, { error: { type: 'provider.transport', message: 'Falha simulada na subtarefa.' } });
        } else {
          const reply = `RESULT[${turn.subtaskId ?? turn.role}] by ${model}`;
          emitted.add(reply);
          await fake.emitTurn(sessionID, { text: reply });
        }
        appendFileSync(turnLogPath(), `${JSON.stringify({ role: turn.role, subtaskId: turn.subtaskId, model, sessionID, start, end: Date.now(), ...summarizePrompt(turn.text, emitted) })}\n`, { mode: 0o600 });
      }, delay);
    },
  };
}
