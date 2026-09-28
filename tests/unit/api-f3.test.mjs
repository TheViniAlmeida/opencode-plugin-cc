import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, assertId } from '../../plugins/opc/scripts/lib/api.mjs';

function recorder(responses = {}) {
  const calls = [];
  const client = {
    directory: '/ws',
    baseUrl: 'http://127.0.0.1:1',
    async request(method, path, opts = {}) {
      calls.push({ method, path, body: opts.body, query: opts.query, timeoutMs: opts.timeoutMs });
      return responses[`${method} ${path}`] ?? null;
    },
  };
  client.get = (path, opts = {}) => client.request('GET', path, opts);
  client.post = (path, body, opts = {}) => client.request('POST', path, { ...opts, body });
  client.patch = (path, body, opts = {}) => client.request('PATCH', path, { ...opts, body });
  return { client, calls };
}

test('assertId accepts real-looking ids and rejects path tricks', () => {
  assert.equal(assertId('ses', 'ses_2b1XyZ-9'), 'ses_2b1XyZ-9');
  assert.equal(assertId('msg', 'msg_01J'), 'msg_01J');
  for (const bad of ['ses_x/../../global/dispose', 'msg_1', '', undefined, 'ses x', 'ses_$(id)', 'ses_%2e%2e']) {
    assert.throws(() => assertId('ses', bad), (err) => err.exitCode === 2 && err.code === 'INVALID_ID', String(bad));
  }
});

test('fork sends messageID only when given', async () => {
  const { client, calls } = recorder();
  const api = createApi(client);
  await api.fork('ses_a', { messageID: 'msg_b' });
  await api.fork('ses_a');
  assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), [
    ['POST', '/session/ses_a/fork', { messageID: 'msg_b' }],
    ['POST', '/session/ses_a/fork', {}],
  ]);
});

test('revert requires messageID and forwards partID', async () => {
  const { client, calls } = recorder();
  const api = createApi(client);
  await api.revert('ses_a', { messageID: 'msg_b', partID: 'prt_c' });
  assert.deepEqual(calls[0], { method: 'POST', path: '/session/ses_a/revert', body: { messageID: 'msg_b', partID: 'prt_c' }, query: undefined, timeoutMs: undefined });
  assert.throws(() => api.revert('ses_a', {}), (err) => err.exitCode === 2);
  assert.throws(() => api.revert('ses_a', { messageID: 'msg_b', partID: 'bad' }), (err) => err.code === 'INVALID_ID');
});

test('unrevert posts without body; dispose hits /instance/dispose', async () => {
  const { client, calls } = recorder();
  const api = createApi(client);
  await api.unrevert('ses_a');
  await api.dispose();
  assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), [
    ['POST', '/session/ses_a/unrevert', undefined],
    ['POST', '/instance/dispose', undefined],
  ]);
});

test('summarize requires providerID/modelID and passes a long timeout', async () => {
  const { client, calls } = recorder();
  const api = createApi(client);
  await api.summarize('ses_a', { providerID: 'p', modelID: 'm/x', timeoutMs: 600000 });
  assert.deepEqual(calls[0].body, { providerID: 'p', modelID: 'm/x' });
  assert.equal(calls[0].timeoutMs, 600000);
  assert.throws(() => api.summarize('ses_a', { providerID: 'p' }), (err) => err.exitCode === 2);
});

test('runCommand: model as string, arguments default to empty string, undefined fields omitted', async () => {
  const { client, calls } = recorder();
  const api = createApi(client);
  await api.runCommand('ses_a', { command: 'echo', model: 'p/m', timeoutMs: 1800000 });
  assert.deepEqual(calls[0].body, { command: 'echo', arguments: '', model: 'p/m' });
  assert.equal(calls[0].timeoutMs, 1800000);
  await api.runCommand('ses_a', { command: 'echo', arguments: 'x y', agent: 'build', variant: 'high', messageID: 'msg_1' });
  assert.deepEqual(calls[1].body, { command: 'echo', arguments: 'x y', agent: 'build', variant: 'high', messageID: 'msg_1' });
  assert.throws(() => api.runCommand('ses_a', { command: 'echo', model: { providerID: 'p', modelID: 'm' } }), (err) => err.code === 'MODEL_NOT_STRING');
  assert.throws(() => api.runCommand('ses_a', {}), (err) => err.exitCode === 2);
});

test('diff forwards messageID as query', async () => {
  const { client, calls } = recorder();
  const api = createApi(client);
  await api.diff('ses_a');
  await api.diff('ses_a', { messageID: 'msg_b' });
  assert.deepEqual(calls.map((c) => [c.path, c.query]), [
    ['/session/ses_a/diff', undefined],
    ['/session/ses_a/diff', { messageID: 'msg_b' }],
  ]);
});
