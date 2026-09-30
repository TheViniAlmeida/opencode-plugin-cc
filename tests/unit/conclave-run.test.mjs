import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runConclave, buildKnownNames, loadConclaveAssets, validateSchema, REDACTED_NAME, ConclavePersistenceError } from '../../plugins/opc/scripts/lib/conclave.mjs';
import { renderConclave } from '../../plugins/opc/scripts/lib/render.mjs';
import { makeCatalog, member, MEMBERS, KM, answer, debateAnswer, synthesis, ok, failed } from './_conclave-fixtures.mjs';

const assets = loadConclaveAssets();
const knownNames = buildKnownNames(makeCatalog());
const FORBIDDEN = /deepseek|qwen|kimi|omniroute|opencode-go|alibaba|moonshot/i;

function harness(respond, { members = MEMBERS, rounds = 1, quorum = 2, mode = 'opinion', judge = { type: 'claude' }, maxParallel = 4, structuredOutput = 'text', omitKnownNames = false, knownNames: suppliedKnownNames = knownNames, onEvent = null, collectReview = null, promptAssets = assets } = {}) {
  const calls = [];
  const events = [];
  let clock = 1_000;
  const deps = {
    assets: promptAssets,
    ...(omitKnownNames ? {} : { knownNames: suppliedKnownNames }),
    now: () => (clock += 500),
    onEvent: onEvent ?? ((e) => events.push(e)),
    ...(collectReview ? { collectReview } : {}),
    turn: async (spec) => { calls.push(spec); return respond(spec, calls); },
  };
  const flags = { mode, rounds, quorum, members, judge, maxParallel, warnings: [] };
  return { calls, events, run: (question = 'Should we add a write-ahead log?') => runConclave({ ctx: { config: { conclave: { structuredOutput } } }, question, flags, deps }) };
}
const peerOf = (spec) => spec.schema.properties.critiques.items.properties.target.enum[0];
const byRound = (calls, round) => calls.filter((c) => c.round === round);

test('round 1 is blind: one new session per member, member schema, no peer text', async () => {
  const h = harness((spec) => ok(answer(), `ses_${spec.label}`)); const pkg = await h.run('Q?');
  assert.equal(h.calls.length, 3);
  for (const call of h.calls) { assert.equal(call.sessionID, null); assert.equal(call.role, 'member'); assert.equal(call.schema.title, 'ConclaveMember'); assert.match(call.prompt, new RegExp(`member ${call.label}`)); assert.match(call.prompt, /<question>\nQ\?\n<\/question>/); assert.doesNotMatch(call.prompt, /<peer /); }
  assert.equal(pkg.status, 'completed'); assert.deepEqual(pkg.final.responses.map((r) => r.label), ['A', 'B', 'C']); assert.deepEqual(pkg.rounds, { requested: 1, completed: 1 });
});
test('package puts composition last and synthesis input anonymized', async () => {
  const h = harness((spec) => ok(answer({ position: `As kimi-k3 I say yes (${spec.label})` }), `ses_${spec.label}`)); const pkg = await h.run();
  assert.equal(Object.keys(pkg).at(-1), 'composition'); assert.deepEqual(pkg.composition, MEMBERS.map((m) => ({ label: m.label, model: m.full }))); assert.deepEqual(pkg.judge, { type: 'claude', status: 'pending' }); assert.doesNotMatch(JSON.stringify(pkg.synthesisInput), FORBIDDEN); assert.equal(pkg.synthesisInput.responses.length, 3); assert.equal(pkg.durationMs, 500); assert.equal(pkg.schemaVersion, 1);
});
for (const nameCase of ['absent', 'explicitly empty']) {
  test(`composition names redact member self-identification with knownNames ${nameCase}`, async () => {
    const judge = { type: 'model', ...MEMBERS[0] };
    const names = nameCase === 'absent' ? { omitKnownNames: true } : { knownNames: { exact: [], families: [] } };
    const selfId = (s) => ({ position: `I am ${s.member.full}, made by Moonshot` });
    const h = harness((s) => {
      if (s.role === 'judge') return ok(synthesis(['A', 'B', 'C']), 'ses_judge');
      if (s.round === 1) return ok(answer(selfId(s)), `ses_${s.label}`);
      return ok(debateAnswer(peerOf(s), selfId(s)), s.sessionID);
    }, { mode: 'debate', rounds: 2, judge, ...names });
    await h.run();
    const prompts = [...byRound(h.calls, 2), h.calls.find((s) => s.role === 'judge')].map((s) => s.prompt);
    assert.equal(prompts.length, 4);
    for (const prompt of prompts) {
      assert.ok(prompt.includes(REDACTED_NAME));
      assert.doesNotMatch(prompt, FORBIDDEN);
    }
  });
}
test('debate rounds reuse sessions and receive anonymized peers only', async () => {
  const h = harness((s) => s.round === 1 ? ok(answer({ position: `I am ${s.member.modelID} by Moonshot or Alibaba`, key_points: ['DeepSeek style point'] }), `ses_${s.label}`) : ok(debateAnswer(peerOf(s), { changed: s.label === 'A' }), s.sessionID), { mode: 'debate', rounds: 2 });
  const pkg = await h.run(); const r2 = byRound(h.calls, 2); assert.equal(r2.length, 3);
  for (const c of r2) { assert.equal(c.sessionID, `ses_${c.label}`); assert.equal(c.schema.title, 'ConclaveDebate'); assert.doesNotMatch(c.prompt, FORBIDDEN); assert.ok(c.prompt.includes(REDACTED_NAME)); assert.doesNotMatch(c.prompt, new RegExp(`<peer label="${c.label}">`)); const peers = ['A','B','C'].filter((l) => l !== c.label); for (const p of peers) assert.match(c.prompt, new RegExp(`<peer label="${p}">`)); assert.match(c.prompt, new RegExp(`<peer_labels>${peers.join(', ')}</peer_labels>`)); assert.match(c.prompt, /round 2 of 2/); }
  assert.equal(pkg.rounds.completed, 2); assert.deepEqual(pkg.roundsData[1].responses.map((r) => r.response.changed), [true,false,false]);
});
test('completed round one without a session fails member for debate continuity',async()=>{const h=harness(s=>s.round===1?ok(answer(),null):ok(debateAnswer(peerOf(s)),s.sessionID),{mode:'debate',rounds:2});const p=await h.run();assert.deepEqual(p.failures.map(f=>[f.label,f.errorType]),[['A','MissingSession'],['B','MissingSession'],['C','MissingSession']]);assert.deepEqual(p.roundsData[0].responses,[]);});
test('failed member is excluded from later rounds', async () => {
 const h=harness(s=>s.label==='C'?failed('Timeout',{sessionID:'ses_C'}):s.round===1?ok(answer(),`ses_${s.label}`):ok(debateAnswer(peerOf(s)),s.sessionID),{mode:'debate',rounds:2}); const p=await h.run(); assert.equal(p.status,'completed'); assert.deepEqual(byRound(h.calls,2).map(c=>c.label).sort(),['A','B']); assert.deepEqual(p.failures.map(f=>[f.label,f.round,f.errorType]),[['C',1,'Timeout']]); for(const c of byRound(h.calls,2)) assert.doesNotMatch(c.prompt,/<peer label="C">/); assert.ok(h.events.some(e=>e.type==='member-failed'&&e.label==='C'));
});
test('tool mode StructuredOutputError is discarded and raw text kept',async()=>{const h=harness(s=>s.label==='B'?failed('StructuredOutputError',{finalText:'not json at all'}):ok(answer(),`ses_${s.label}`),{structuredOutput:'tool'});const p=await h.run();assert.equal(p.status,'completed');assert.deepEqual(p.failures.map(f=>[f.label,f.errorType,f.rawText]),[['B','StructuredOutputError','not json at all']]);assert.deepEqual(p.final.responses.map(r=>r.label),['A','C']);});
test('text mode prose without structured output is MissingStructuredOutput with raw text',async()=>{const h=harness(s=>s.label==='B'?{status:'completed',sessionID:'ses_B',structured:null,finalText:'plain prose'}:ok(answer(),`ses_${s.label}`));const p=await h.run();assert.deepEqual(p.failures.map(f=>[f.label,f.errorType,f.rawText]),[['B','MissingStructuredOutput','plain prose']]);});
test('text mode judge prose without structured output is MissingStructuredOutput and keeps raw text',async()=>{const h=harness(s=>s.role==='judge'?{status:'completed',sessionID:'judge',structured:null,finalText:'judge prose'}:ok(answer(),`ses_${s.label}`),{members:MEMBERS.slice(0,2),judge:{type:'model',providerID:'x',modelID:'y',full:KM}});const p=await h.run();assert.equal(p.judge.error.errorType,'MissingStructuredOutput');assert.equal(p.judge.error.rawText,'judge prose');assert.deepEqual(p.failures.map(f=>f.rawText),[]);});
test('invalid schema output discarded',async()=>{const h=harness(s=>s.label==='A'?ok(answer({confidence:1.7,extra:true}),'ses_A'):ok(answer(),`ses_${s.label}`));const p=await h.run();assert.equal(p.failures[0].errorType,'InvalidStructuredOutput');assert.match(p.failures[0].message, /\$\.confidence/);});
test('completed turn without structured output discarded',async()=>{const h=harness(s=>s.label==='A'?{status:'completed',sessionID:'ses_A',structured:null,finalText:'hi'}:ok(answer(),`ses_${s.label}`));assert.equal((await h.run()).failures[0].errorType,'MissingStructuredOutput');});
test('thrown turn becomes a failure',async()=>{const h=harness(s=>{if(s.label==='A')throw Object.assign(new Error('socket closed'),{code:'SERVER_DOWN'});return ok(answer(),`ses_${s.label}`)});assert.deepEqual((await h.run()).failures.map(f=>[f.label,f.errorType,f.message]),[['A','SERVER_DOWN','socket closed']]);});
test('round 1 quorum failure retains partial responses and skips judge',async()=>{const h=harness(s=>s.label==='A'?ok(answer(),'ses_A'):failed('Timeout'),{mode:'debate',rounds:2,quorum:2,judge:{type:'model',full:KM,providerID:'x',modelID:'y'}});const p=await h.run();assert.equal(p.status,'failed');assert.deepEqual(p.failure,{code:'QUORUM_NOT_MET',round:1,valid:1,quorum:2});assert.equal(h.calls.length,3);assert.deepEqual(p.final.responses.map(r=>r.label),['A']);assert.deepEqual(p.judge,{type:'model',model:KM,status:'skipped'});assert.equal(p.synthesisInput,null);assert.deepEqual(p.rounds,{requested:2,completed:0});});
test('round 2 quorum failure retains prior completed rounds',async()=>{const h=harness(s=>s.round===1?ok(answer(),`ses_${s.label}`):s.label==='A'?ok(debateAnswer(peerOf(s)),s.sessionID):failed('APIError'),{mode:'debate',rounds:2,quorum:3});const p=await h.run();assert.equal(p.status,'failed');assert.equal(p.failure.round,2);assert.deepEqual(p.rounds,{requested:2,completed:1});});
test('members respect maxParallel',async()=>{let active=0,peak=0;const h=harness(async s=>{active++;peak=Math.max(active,peak);await new Promise(r=>setTimeout(r,20));active--;return ok(answer(),`ses_${s.label}`)},{maxParallel:2});await h.run();assert.equal(peak,2);});
test('huge peer answers are truncated',async()=>{const h=harness(s=>s.round===1?ok(answer({position:'x'.repeat(40000)}),`ses_${s.label}`):ok(debateAnswer(peerOf(s)),s.sessionID),{mode:'debate',rounds:2});await h.run();const p=byRound(h.calls,2)[0].prompt;assert.match(p,/…\[truncated \d+ chars\]/);assert.ok(p.length<40000);});
test('judge sees labels and validates synthesis',async()=>{const judge={type:'model',providerID:'omniroute-personal',modelID:'opencode-go/kimi-k3',full:KM};const h=harness(s=>s.role==='judge'?ok(synthesis(['A','B']),'ses_judge'):ok(answer({position:`I am ${s.member.full}`}),`ses_${s.label}`),{members:MEMBERS.slice(0,2),judge});const p=await h.run();const c=h.calls.find(c=>c.role==='judge');assert.equal(c.sessionID,null);assert.equal(c.schema.title,'ConclaveSynthesis');assert.match(c.prompt,/<labels>A, B<\/labels>/);assert.doesNotMatch(c.prompt,FORBIDDEN);assert.match(c.prompt,/Not a review conclave\./);assert.equal(p.judge.status,'completed');assert.deepEqual(validateSchema(p.judge.synthesis,c.schema),[]);assert.equal(p.judge.model,KM);});
test('tool mode judge StructuredOutputError keeps raw text',async()=>{const judge={type:'model',providerID:'omniroute-personal',modelID:'opencode-go/kimi-k3',full:KM};const h=harness(s=>s.role==='judge'?failed('StructuredOutputError',{finalText:'judge raw tool output'}):ok(answer(),`ses_${s.label}`),{members:MEMBERS.slice(0,2),judge,structuredOutput:'tool'});const p=await h.run();assert.equal(p.status,'completed');assert.equal(p.judge.status,'failed');assert.equal(p.judge.error.errorType,'StructuredOutputError');assert.equal(p.judge.error.rawText,'judge raw tool output');assert.ok(p.warnings.some(w=>/opc-conclave/.test(w)));assert.ok(p.synthesisInput);});
test('judge prompt reports extra debate rounds',async()=>{const judge={type:'model',providerID:'omniroute-personal',modelID:'opencode-go/kimi-k3',full:KM};const h=harness(s=>s.role==='judge'?ok(synthesis(['A','B']),'ses_judge'):s.round===1?ok(answer(),`ses_${s.label}`):ok(debateAnswer(peerOf(s)),s.sessionID),{members:MEMBERS.slice(0,2),judge,mode:'debate',rounds:3});await h.run();assert.match(h.calls.find(c=>c.role==='judge').prompt,/debated for 2 more round\(s\)/);});
test('question passes through verbatim',async()=>{const q='Is `rm -rf $(pwd)` "safe"? \'no\' — ção 🚀\nline2';const h=harness(s=>ok(answer(),`ses_${s.label}`));const p=await h.run(q);assert.ok(h.calls.every(c=>c.prompt.includes(q)));assert.equal(p.question,q);});

test('the question stays literal in the package and in synthesisInput (A5)', async () => {
  const h = harness((s) => ok(answer({ position: `As ${s.member.modelID} I agree` }), `ses_${s.label}`));
  const pkg = await h.run('Is kimi-k3 better than qwen3.8-max here?');
  assert.ok(pkg.synthesisInput);
  assert.equal(pkg.question, 'Is kimi-k3 better than qwen3.8-max here?');
  assert.equal(pkg.synthesisInput.question, 'Is kimi-k3 better than qwen3.8-max here?');
  const { question, ...rest } = pkg.synthesisInput;
  assert.doesNotMatch(JSON.stringify(rest), FORBIDDEN);
});

test('member and review strings are anonymized throughout package except question and composition', async () => {
  const reviewAnswer = { verdict:'needs-attention', summary:'Kimi review', next_steps:['Review Kimi changes'], findings:[{title:'Kimi issue',body:'DeepSeek body',recommendation:'Qwen fix',file:'src/a.js',line_start:1,line_end:1,severity:'high',confidence:.9}] };
  const h = harness((s) => ok(s.label === 'A' ? reviewAnswer : { ...reviewAnswer, verdict:'approve' }, `ses_${s.label}`), { mode:'review', judge:{type:'claude'}, knownNames:{ exact:['claude','opinion','completed','pending','member','high','approve'], families:['kimi','deepseek','qwen'] }, collectReview: async () => ({ content:'review fixture', label:'fixture' }) });
  const pkg = await h.run('Question includes kimi-k3 intentionally');
  const beforeComposition = { roundsData:pkg.roundsData, final:pkg.final, review:pkg.review, judge:pkg.judge, failures:pkg.failures, warnings:pkg.warnings, synthesisInput:pkg.synthesisInput ? { ...pkg.synthesisInput, question: '' } : null };
  assert.doesNotMatch(JSON.stringify(beforeComposition), /kimi|deepseek|qwen/i);
  assert.match(pkg.question, /kimi-k3/);
  if (pkg.synthesisInput) assert.match(pkg.synthesisInput.question, /kimi-k3/);
  assert.match(JSON.stringify(pkg.composition), /deepseek|qwen/i);
  for (const { response } of pkg.roundsData[0].responses) {
    assert.ok(['needs-attention', 'approve'].includes(response.verdict));
    assert.equal(response.findings[0].severity, 'high');
    assert.equal(response.findings[0].file, 'src/a.js');
    assert.equal(response.findings[0].line_start, 1);
  }
  assert.ok(pkg.review.clusters.every((cluster) => cluster.severity === 'high' && cluster.line_start === 1));
  assert.ok(pkg.review.clusters.every((cluster) => cluster.agreement.text === '3/3'));
});

test('field-aware anonymization preserves package structure and redacts model text', async () => {
  const names = { exact: ['claude', 'opinion', 'completed', 'pending', 'member', 'high', 'approve'], families: [] };
  const response = answer({ position: 'I am Claude and my opinion is approve by a member with high confidence' });
  const h = harness(() => ok(response, 'ses_A'), { members: MEMBERS.slice(0, 2), quorum: 2, knownNames: names });
  const pkg = await h.run();
  assert.equal(pkg.mode, 'opinion');
  assert.equal(pkg.status, 'completed');
  assert.deepEqual(pkg.judge, { type: 'claude', status: 'pending' });
  const clean = pkg.final.responses[0].response;
  assert.equal(clean.position, `I am ${REDACTED_NAME} and my ${REDACTED_NAME} is ${REDACTED_NAME} by a ${REDACTED_NAME} with ${REDACTED_NAME} confidence`);
  assert.deepEqual([pkg.schemaVersion, pkg.kind, pkg.status, pkg.mode, pkg.rounds.requested, pkg.judge.type, pkg.judge.status], [1, 'conclave', 'completed', 'opinion', 1, 'claude', 'pending']);
  assert.doesNotThrow(() => renderConclave(pkg));
});

test('runConclave awaits onEvent callbacks in order', async () => {
  const seen = [];
  const h = harness(() => ok(answer(), 'ses'), { members: MEMBERS.slice(0, 2), quorum: 2, onEvent: async (event) => {
    await new Promise((resolve) => setTimeout(resolve, 2));
    seen.push(event.type === 'member-start' || event.type === 'member-done' ? `${event.type}:${event.label}` : event.type);
  } });
  await h.run();
  assert.deepEqual(seen, ['round-start', 'member-start:A', 'member-start:B', 'member-done:A', 'member-done:B']);
});

test('runConclave rejects when onEvent rejects without an unhandled rejection', async () => {
  const h = harness(() => ok(answer(), 'ses'), { onEvent: async () => { throw new Error('event persistence failed'); } });
  await assert.rejects(h.run(), /event persistence failed/);
});

for (const role of ['member', 'judge']) {
  test(`marked ${role} persistence errors propagate unchanged`, async () => {
    const error = new ConclavePersistenceError(Object.assign(new Error('state write failed'), { code: 'EIO' }));
    const h = harness((spec) => {
      if (spec.role === role) throw error;
      return ok(answer(), `ses_${spec.label}`);
    }, { judge: { type: 'model', ...MEMBERS[2] } });
    await assert.rejects(h.run(), (err) => err === error && err.code === 'coordinator_error');
  });
}

test('cancelled turn remains a member failure when the other members reach quorum', async () => {
  const h = harness((spec) => spec.label === 'A'
    ? { ...failed('Cancelled'), status: 'cancelled' }
    : ok(answer(), `ses_${spec.label}`));
  const pkg = await h.run();
  assert.equal(pkg.status, 'completed');
  assert.deepEqual(pkg.failures.map((f) => [f.label, f.errorType]), [['A', 'Cancelled']]);
});

test('persistence failure drains in-flight turns and stops scheduling queued members', async () => {
  let release, started;
  const blocked = new Promise((resolve) => { release = resolve; });
  const running = new Promise((resolve) => { started = resolve; });
  let drained = false;
  const error = new ConclavePersistenceError(new Error('state write failed'));
  const h = harness(async (spec) => {
    if (spec.label === 'A') { await running; throw error; }
    started();
    await blocked;
    drained = true;
    return ok(answer(), `ses_${spec.label}`);
  }, { maxParallel: 2 });
  let settled = false;
  const result = h.run().finally(() => { settled = true; });
  const rejection = assert.rejects(result, (err) => err === error);
  await running;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  await rejection;
  assert.equal(drained, true);
  assert.deepEqual(h.calls.map((c) => c.label), ['A', 'B']);
});

test('evidence file names are anonymized in packages, peers, judge and Markdown', async () => {
  const evidence = [{ file: 'deepseek/notes.md', line_start: 1, line_end: 2, note: 'Checked notes.' }];
  const h = harness((spec) => spec.role === 'judge'
    ? ok(synthesis(['A', 'B', 'C']), 'ses_judge')
    : ok(spec.round === 1 ? answer({ evidence }) : debateAnswer(peerOf(spec), { evidence }), `ses_${spec.label}`),
  { mode: 'debate', rounds: 2, judge: { type: 'model', ...MEMBERS[2] } });
  const pkg = await h.run();
  const json = JSON.stringify(pkg);
  assert.doesNotMatch(json.slice(0, json.indexOf('"composition":')), /deepseek/i);
  for (const round of pkg.roundsData) {
    for (const entry of round.responses) assert.equal(entry.response.evidence[0].file, '[redacted]/notes.md');
  }
  assert.equal(pkg.synthesisInput.responses[0].response.evidence[0].file, '[redacted]/notes.md');
  for (const call of h.calls.filter((c) => c.round === 2 || c.role === 'judge')) {
    assert.doesNotMatch(call.prompt, /deepseek/i);
    assert.ok(call.prompt.includes('[redacted]/notes.md'));
  }
  const markdown = renderConclave(pkg);
  assert.doesNotMatch(markdown.slice(0, markdown.indexOf('## Composição')), /deepseek/i);
  assert.deepEqual(evidence[0], { file: 'deepseek/notes.md', line_start: 1, line_end: 2, note: 'Checked notes.' });
});

for (const mode of ['text', 'tool']) {
  test(`${mode} member, debate and judge prompts have exactly one mode-specific contract`, async () => {
    const h = harness((spec) => spec.role === 'judge'
      ? ok(synthesis(['A', 'B', 'C']), 'ses_judge')
      : ok(spec.round === 1 ? answer() : debateAnswer(peerOf(spec)), `ses_${spec.label}`),
    { mode: 'debate', rounds: 2, structuredOutput: mode, judge: { type: 'model', ...MEMBERS[2] } });
    await h.run();
    assert.equal(h.calls.length, 7);
    for (const { prompt } of h.calls) {
      assert.doesNotMatch(prompt, /Reply only through the structured output/);
      assert.equal(prompt.split('Return your answer only through the structured output.').length - 1, mode === 'tool' ? 1 : 0);
      assert.equal(prompt.split('Return only one JSON object inside a single ```json fence').length - 1, mode === 'text' ? 1 : 0);
      assert.equal(prompt.includes('Return a JSON instance with field values, not the schema.'), mode === 'text');
    }
  });
}

test('runConclave adds member and judge model words to filtered catalog names; provider words only when specific', async () => {
  const members = [member('A', 'acme-cloud/zeta-9-pro'), member('B', 'other-provider/sigma-2')];
  const judge = { type: 'model', ...member('judge', 'arbiter-host/quasar-8') };
  const prose = 'For a small Node.js CLI with zero runtime dependencies, tools in the ecosystem are free and built-in; users cannot add comments.';
  const names = buildKnownNames(makeCatalog([
    ...members, judge,
    { full: 'free-tools/small', name: 'Free Tools Small' },
    { full: 'ecosystem-users/zero-shot-1', name: 'For Coding' },
  ], []));
  const h = harness((s) => s.role === 'judge'
    ? ok(synthesis(['A', 'B'], { recommendation: 'Quasar from arbiter agrees.' }), 'ses_judge')
    : ok(answer({ position: `${prose} Zeta from acme; Sigma from other; Quasar from arbiter.` }), `ses_${s.label}`),
  { members, judge, knownNames: names });
  const pkg = await h.run();
  assert.equal(pkg.final.responses[0].response.position, `${prose} ${REDACTED_NAME} from acme; ${REDACTED_NAME} from other; ${REDACTED_NAME} from arbiter.`);
  assert.equal(pkg.judge.synthesis.recommendation, `${REDACTED_NAME} from arbiter agrees.`);
  const prompt = h.calls.find((s) => s.role === 'judge').prompt;
  assert.ok(prompt.includes(prose));
  assert.doesNotMatch(prompt, /zeta|sigma|quasar|acme-cloud|arbiter-host/i);
});

for (const mode of ['text', 'tool']) {
  test(`${mode} accepts schema-shaped member, debate and judge values without changing raw turns`, async () => {
    const turns = [];
    const expected = [];
    const h = harness((s) => {
      const value = s.role === 'judge' ? synthesis(['A', 'B', 'C']) : s.round === 1 ? answer() : debateAnswer(peerOf(s));
      const wrapped = { title: s.schema.title, properties: value };
      const turn = Object.freeze({ ...ok(wrapped, s.sessionID ?? `ses_${s.label}`), finalText: `\`\`\`json\n${JSON.stringify(wrapped)}\n\`\`\`` });
      turns.push(turn);
      expected.push(structuredClone(turn));
      return turn;
    }, { mode: 'debate', rounds: 2, structuredOutput: mode, judge: { type: 'model', ...MEMBERS[2] } });
    const pkg = await h.run();
    assert.equal(pkg.status, 'completed');
    assert.deepEqual(pkg.failures, []);
    assert.deepEqual(pkg.rounds, { requested: 2, completed: 2 });
    assert.ok(pkg.roundsData.every((r) => r.responses.length === 3));
    assert.deepEqual(pkg.roundsData[0].responses[0].response, answer());
    assert.deepEqual(pkg.final.responses[0].response, debateAnswer('B'));
    assert.deepEqual(pkg.judge.synthesis, synthesis(['A', 'B', 'C']));
    assert.deepEqual(turns, expected, 'structured and finalText stay untouched');
    assert.equal(h.events.filter((e) => e.type === 'member-done').length, 6);
    assert.equal(h.events.some((e) => /failed|normaliz|unwrap/.test(e.type)), false);
  });

  test(`${mode} only unwraps one object level when properties itself validates`, async () => {
    for (const properties of [null, [], 'answer', {}, answer({ confidence: 2 }), { properties: answer() }, assets.schemas.member.properties]) {
      const wrapped = { title: 'ConclaveMember', properties };
      const rawText = JSON.stringify(wrapped);
      const h = harness((s) => s.label === 'A' ? { ...ok(wrapped, 'ses_A'), finalText: rawText } : ok(answer(), `ses_${s.label}`), { structuredOutput: mode });
      const pkg = await h.run();
      assert.deepEqual(pkg.final.responses.map((r) => r.label), ['B', 'C']);
      assert.equal(pkg.failures[0].errorType, 'InvalidStructuredOutput');
      assert.match(pkg.failures[0].message, /\$\.position é obrigatório/);
      assert.equal(pkg.failures[0].rawText, rawText);
    }
  });

  test(`${mode} drops schema keywords echoed beside valid values`, async () => {
    const echoed = { title: 'ConclaveMember', $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', ...answer() };
    const h = harness((s) => s.label === 'A' ? { ...ok(echoed, 'ses_A'), finalText: JSON.stringify(echoed) } : ok(answer(), `ses_${s.label}`), { structuredOutput: mode });
    const pkg = await h.run();
    assert.deepEqual(pkg.failures, []);
    assert.deepEqual(pkg.final.responses.find((r) => r.label === 'A').response, answer());
    const bad = { title: 'ConclaveMember', ...answer({ confidence: 2 }) };
    const h2 = harness((s) => s.label === 'A' ? ok(bad, 'ses_A') : ok(answer(), `ses_${s.label}`), { structuredOutput: mode });
    const pkg2 = await h2.run();
    assert.equal(pkg2.failures[0].errorType, 'InvalidStructuredOutput');
  });

  test(`${mode} preserves an already valid object even when it has valid properties`, async () => {
    const promptAssets = structuredClone(assets);
    promptAssets.schemas.member.additionalProperties = true;
    const response = answer({ properties: answer({ position: 'Different nested position.' }) });
    const h = harness((s) => ok(response, `ses_${s.label}`), { promptAssets, structuredOutput: mode });
    const pkg = await h.run();
    assert.deepEqual(pkg.failures, []);
    assert.deepEqual(pkg.final.responses[0].response, response);
  });

  test(`${mode} never rescues failed turns with schema-shaped values`, async () => {
    const h = harness((s) => s.label === 'A' ? { ...failed('Timeout', { finalText: 'raw failure' }), structured: { properties: answer() } } : ok(answer(), `ses_${s.label}`), { structuredOutput: mode });
    const pkg = await h.run();
    assert.deepEqual(pkg.failures.map((f) => [f.errorType, f.rawText]), [['Timeout', 'raw failure']]);
  });
}
