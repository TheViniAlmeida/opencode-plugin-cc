// Shared behaviour of the F4b fake scenarios. Runs inside the fake OpenCode process.
import { appendFileSync } from 'node:fs';
import { redactText } from '../../plugins/opc/scripts/lib/redact.mjs';

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

export function makeOrchestrateScenario({ plan = null, plannerText = null, failSubtasks = [], subtaskDelayMs = 300, synthesisText = 'SYNTHESIS-OK: combined answer' } = {}) {
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
          await fake.emitTurn(sessionID, { text: `RESULT[${turn.subtaskId ?? turn.role}] by ${model}` });
        }
        appendFileSync(turnLogPath(), `${JSON.stringify({ role: turn.role, subtaskId: turn.subtaskId, model, sessionID, start, end: Date.now(), prompt: redactText(turn.text) })}\n`, { mode: 0o600 });
      }, delay);
    },
  };
}
