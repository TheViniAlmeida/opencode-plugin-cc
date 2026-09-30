import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runConclave, buildKnownNames, loadConclaveAssets, validateSchema, REDACTED_NAME } from '../../plugins/opc/scripts/lib/conclave.mjs';
import { makeCatalog, MEMBERS, KM, answer, debateAnswer, synthesis, ok, failed } from './_conclave-fixtures.mjs';

const assets = loadConclaveAssets();
const knownNames = buildKnownNames(makeCatalog());
const FORBIDDEN = /deepseek|qwen|kimi|omniroute|opencode-go|alibaba|moonshot/i;

function harness(respond, { members = MEMBERS, rounds = 1, quorum = 2, mode = 'opinion', judge = { type: 'claude' }, maxParallel = 4, structuredOutput = 'text', omitKnownNames = false, knownNames: suppliedKnownNames = knownNames } = {}) {
  const calls = [];
  const events = [];
  let clock = 1_000;
  const deps = {
    assets,
    ...(omitKnownNames ? {} : { knownNames: suppliedKnownNames }),
    now: () => (clock += 500),
    onEvent: (e) => events.push(e),
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
for (const nameCase of ['absent', 'explicitly empty']) test(`composition names redact member self-identification with knownNames ${nameCase}`, async () => {
 const judge={type:'model',...MEMBERS[0]};
 const options={mode:'debate',rounds:2,judge,...(nameCase==='absent'?{omitKnownNames:true}:{knownNames:{exact:[],families:[]}})};
 const h=harness(s=>s.role==='judge'?ok(synthesis(['A','B','C']),'judge'):s.round===1?ok(answer({position:`I am ${s.member.full}, made by Moonshot`}),`ses_${s.label}`):ok(debateAnswer(peerOf(s)),s.sessionID),options);
 await h.run();
 for(const s of byRound(h.calls,2)) assert.match(s.prompt,/\[redacted\]/);
 assert.match(h.calls.find(s=>s.role==='judge').prompt,/\[redacted\]/);
});
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
