import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mergeOpencodeConfigSources } from '../../plugins/opc/scripts/lib/opencode-config.mjs';
import { REPO_ROOT } from '../helpers.mjs';

const sources = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/contract/opencode-2.0.22/config-precedence.json'), 'utf8'));

test('the merged model follows the documented ascending order: global file, project file, env content (server side A CONFIRMAR, F7 P1)', () => {
  // The F7 live probe left P1 as "unknown" on the server side; the fixture lists the documents in the order
  // OpenCode documents (ascending precedence), so the last one (env content) wins.
  const SERVER_PICKED = 'omniroute-personal/probe/model-env';
  assert.equal(mergeOpencodeConfigSources(sources).model, SERVER_PICKED);
});

test('V2 object-form model and small_model become "<providerID>/<model>" strings', () => {
  const merged = mergeOpencodeConfigSources([
    { type: 'document', info: { model: { providerID: 'p1', model: 'a/b' }, small_model: { providerID: 'p2', model: 'small' }, share: 'disabled' } },
  ]);
  assert.deepEqual(merged, { model: 'p1/a/b', small_model: 'p2/small', share: 'disabled' });
});

test('an object-form model accepts "id" as an alias of "model"', () => {
  assert.equal(mergeOpencodeConfigSources([{ type: 'document', info: { model: { providerID: 'p1', id: 'm1' } } }]).model, 'p1/m1');
});

test('string models are left untouched', () => {
  const merged = mergeOpencodeConfigSources([{ type: 'document', info: { model: 'p1/m1', small_model: 'p2/m2' } }]);
  assert.deepEqual(merged, { model: 'p1/m1', small_model: 'p2/m2' });
});

test('malformed object models are dropped instead of producing "undefined/..." and keep an earlier valid value', () => {
  const merged = mergeOpencodeConfigSources([
    { type: 'document', info: { model: 'good/model' } },
    { type: 'document', info: { model: { providerID: 'p1' }, small_model: { model: 'only-model' } } },
    { type: 'document', info: { model: ['p1', 'm1'] } },
  ]);
  assert.deepEqual(merged, { model: 'good/model' });
  assert.deepEqual(mergeOpencodeConfigSources([{ type: 'document', info: { model: { providerID: 'p1', model: '' } } }]), {});
});

test('merging does not mutate the source documents', () => {
  const source = { type: 'document', info: { model: { providerID: 'p1', model: 'm1' } } };
  mergeOpencodeConfigSources([source]);
  assert.deepEqual(source.info.model, { providerID: 'p1', model: 'm1' });
});
