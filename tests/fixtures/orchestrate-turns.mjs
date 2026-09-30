// Shared behaviour of the F4b fake scenarios. Runs inside the fake OpenCode process.
import { appendFileSync } from 'node:fs';

export function turnLogPath(stateFile = process.env.FAKE_OPENCODE_STATE) {
  return `${stateFile}.turns.jsonl`;
}

export function promptText(body) {
  return (body?.parts ?? []).filter((p) => p?.type === 'text').map((p) => p.text).join('\n');
}

// planner = structured output requested; synthesizer = results block; subtask = <subtask id>.
export function classifyTurn(body) {
  const text = promptText(body);
  if (body?.format?.type === 'json_schema') return { role: 'planner', subtaskId: null, text };
  if (text.includes('<orchestration_results>')) return { role: 'synthesizer', subtaskId: null, text };
  const match = text.match(/<subtask id="([^"]+)">/);
  if (match) return { role: 'subtask', subtaskId: match[1], text };
  return { role: 'other', subtaskId: null, text };
}

export function makeOrchestrateScenario({ plan = null, plannerError = null, failSubtasks = [], subtaskDelayMs = 300, synthesisText = 'SYNTHESIS-OK: combined answer' } = {}) {
  return {
    onPromptAsync(fake, sessionID, body) {
      const turn = classifyTurn(body);
      const model = body?.model?.modelID ?? null;
      const start = Date.now();
      const delay = turn.role === 'subtask' ? subtaskDelayMs : 20;
      setTimeout(async () => {
        if (turn.role === 'planner') {
          await fake.emitTurn(sessionID, plannerError ? { error: plannerError } : { text: '', structured: plan });
        } else if (turn.role === 'synthesizer') {
          await fake.emitTurn(sessionID, { text: synthesisText });
        } else if (turn.role === 'subtask' && failSubtasks.includes(turn.subtaskId)) {
          await fake.emitTurn(sessionID, { error: { name: 'UnknownError', data: { message: `boom in ${turn.subtaskId}` } } });
        } else {
          await fake.emitTurn(sessionID, { text: `RESULT[${turn.subtaskId ?? turn.role}] by ${model}` });
        }
        appendFileSync(turnLogPath(), `${JSON.stringify({ role: turn.role, subtaskId: turn.subtaskId, model, sessionID, start, end: Date.now(), prompt: turn.text })}\n`, { mode: 0o600 });
      }, delay);
    },
  };
}
