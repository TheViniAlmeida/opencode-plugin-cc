import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTextJson } from '../../plugins/opc/scripts/lib/text-json.mjs';
import { validateReviewOutput } from '../../plugins/opc/scripts/lib/render.mjs';

const valid = { verdict: 'approve', summary: 'Tudo certo.', findings: [], next_steps: [] };
const json = JSON.stringify(valid);
for (const [name, text] of [
  ['array', `[${json}]`], ['prose array', `Resposta: [${json}] fim`],
  ['nested arrays', `Resposta: [[${json}]] fim`], ['nested object', `Resposta: {"example":${json}} fim`],
  ['JSON string', JSON.stringify(json)], ['quoted in prose', `Resposta: ${JSON.stringify(json)} fim`],
  ['last fence array', `\`\`\`json\n${json}\n\`\`\`\n\`\`\`json\n[${json}]\n\`\`\``],
]) {
  test(`rejects ${name}`, () => assert.equal(extractTextJson(text, validateReviewOutput), null));
}
for (const value of ['null', 'true', '42', '"value"', '[]']) {
  test(`rejects non-object ${value} even with a permissive validator`, () => assert.equal(extractTextJson(value, () => null), null));
}
for (const text of [json, `Prosa ${json} fim`, `Exemplo: [${json}] Resposta: ${json}`, `\`\`\`json\n${json}\n\`\`\``]) {
  test('accepts a top-level object', () => assert.deepEqual(extractTextJson(text, validateReviewOutput), valid));
}
test('does not fall back to an earlier object when the last one is invalid', () => {
  assert.equal(extractTextJson(`${json} depois {"invalid":true}`, validateReviewOutput), null);
});
