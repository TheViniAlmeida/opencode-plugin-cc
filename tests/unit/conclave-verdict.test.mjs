import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conclaveVerdict } from '../../plugins/opc/scripts/lib/conclave.mjs';

const cluster = (id, severity, k, n = 3) => ({ id, severity, agreement: { k, n, text: `${k}/${n}` } });

test('needs-attention when a high or critical cluster has agreement >= 2', () => {
  const out = conclaveVerdict([cluster('C1', 'high', 2)], { A: 'approve', B: 'approve', C: 'approve' });
  assert.equal(out.verdict, 'needs-attention');
  assert.deepEqual(out.reasons, [{ code: 'SEVERE_FINDING_AGREED', clusterId: 'C1', severity: 'high', agreement: '2/3' }]);
  assert.equal(conclaveVerdict([cluster('C1', 'critical', 3)], { A: 'approve', B: 'approve', C: 'approve' }).verdict, 'needs-attention');
});

test('a severe finding seen by a single member does not flip the verdict alone', () => {
  assert.equal(conclaveVerdict([cluster('C1', 'critical', 1)], { A: 'needs-attention', B: 'approve', C: 'approve' }).verdict, 'approve');
});

test('medium clusters never flip the verdict, whatever the agreement', () => {
  assert.equal(conclaveVerdict([cluster('C1', 'medium', 3)], { A: 'approve', B: 'approve', C: 'approve' }).verdict, 'approve');
});

test('needs-attention when more than half of valid members say so', () => {
  const out = conclaveVerdict([], { A: 'needs-attention', B: 'needs-attention', C: 'approve' });
  assert.equal(out.verdict, 'needs-attention');
  assert.deepEqual(out.reasons, [{ code: 'MAJORITY_NEEDS_ATTENTION', count: 2, of: 3 }]);
});

test('exactly half is not a majority', () => {
  assert.equal(conclaveVerdict([], { A: 'needs-attention', B: 'needs-attention', C: 'approve', D: 'approve' }).verdict, 'approve');
});

test('both reasons are reported together', () => {
  const out = conclaveVerdict([cluster('C1', 'high', 2)], { A: 'needs-attention', B: 'needs-attention', C: 'approve' });
  assert.deepEqual(out.reasons.map((r) => r.code), ['SEVERE_FINDING_AGREED', 'MAJORITY_NEEDS_ATTENTION']);
});

test('no members and no clusters approves', () => {
  assert.deepEqual(conclaveVerdict([], {}), { verdict: 'approve', reasons: [] });
});
