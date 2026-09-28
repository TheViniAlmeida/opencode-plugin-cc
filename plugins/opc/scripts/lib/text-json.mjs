// Extract only object roots; arrays and quoted values never expose nested candidates.
export function extractTextJson(text, validate) {
  const raw = String(text ?? '').trim();
  const accept = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && validate(value) === null ? value : null;
  try { return accept(JSON.parse(raw)); } catch { /* try the last JSON fence */ }
  const fences = [...raw.matchAll(/```json\s*\n([\s\S]*?)```/gi)];
  if (fences.length) {
    try { return accept(JSON.parse(fences.at(-1)[1].trim())); } catch { /* try a balanced object in prose */ }
  }
  const stack = [];
  let start = -1, quoted = false, escaped = false, last = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === '{' || ch === '[') {
      if (stack.length === 0) start = ch === '{' ? i : -1;
      stack.push(ch);
    } else if (ch === '}' || ch === ']') {
      if (stack.at(-1) !== (ch === '}' ? '{' : '[')) continue;
      stack.pop();
      if (stack.length === 0 && start >= 0) last = raw.slice(start, i + 1);
    }
  }
  try { return last === null ? null : accept(JSON.parse(last)); } catch { return null; }
}
