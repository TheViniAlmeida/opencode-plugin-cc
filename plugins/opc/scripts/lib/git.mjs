// Adapted from openai/codex-plugin-cc (Apache-2.0); modified: 400 KB inline limit, chunked
// per-file mode (smallest diffs first) instead of self-collect, sensitive-path exclusion,
// symlinks never followed, literal pathspecs, NUL-separated file lists, opc error types,
// diffSizeEstimate.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { ExitCode, OpcError, UsageError } from './opc-error.mjs';
import { matchesAny } from './models.mjs';

export const DEFAULT_MAX_INLINE_BYTES = 400 * 1024;
const MAX_UNTRACKED_BYTES = 24 * 1024;
const MAX_LINECOUNT_BYTES = 1024 * 1024;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const OMITTED_LIST_BYTES = 16 * 1024;
const SECTION_RESERVE_BYTES = 1024;
const SUPPORTED_SCOPES = new Set(['auto', 'working-tree', 'branch']);
const DIFF_BASE = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--submodule=diff'];

export const INLINE_GUIDANCE = 'Use o contexto do repositório abaixo como evidência principal.';
export const CHUNKED_GUIDANCE = [
  'O contexto do repositório abaixo é parcial porque o diff completo excede o limite inline.',
  'Ele contém as estatísticas completas do diff e os diffs por arquivo que couberam, começando pelos menores.',
  'Os arquivos listados em "Arquivos omitidos" não têm diff abaixo: leia esses arquivos alterados com a ferramenta read antes de concluir achados sobre eles.',
  'Você não pode executar bash nem git.',
].join(' ');

function git(cwd, args, { maxBuffer = GIT_MAX_BUFFER } = {}) {
  return spawnSync('git', ['-c', 'core.quotepath=off', '--literal-pathspecs', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer,
    shell: false,
    windowsHide: true,
  });
}

function gitStderrSummary(result, cwd) {
  const raw = String(result?.stderr ?? result?.error?.message ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  const safe = raw
    .replaceAll(cwd, '[caminho]')
    .replace(/(?:\/[A-Za-z0-9._-]+){2,}/g, '[caminho]')
    .replace(/(?:https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '[credencial]@')
    .replace(/\b(?:token|password|senha|secret|api[_-]?key)=\S+/gi, (match) => `${match.slice(0, match.indexOf('='))}=[redigido]`);
  return truncateUtf8(safe || 'erro sem detalhes do Git', 200);
}

function gitFailure(args, result, cwd) {
  const summary = gitStderrSummary(result, cwd);
  return new OpcError('GIT_FAILED', `Falha ao executar git ${args[0]}: ${summary}`, { exitCode: ExitCode.USAGE });
}

function gitChecked(cwd, args, options) {
  const result = git(cwd, args, options);
  if (result.error || result.status !== 0) throw gitFailure(args, result, cwd);
  return result.stdout;
}

function splitNul(output) {
  return output.split('\0').filter(Boolean);
}

function uniqueSorted(...groups) {
  return [...new Set(groups.flat())].sort();
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

export function truncateUtf8(text, maxBytes) {
  if (byteLength(text) <= maxBytes) return text;
  const buffer = Buffer.from(text, 'utf8');
  let end = Math.max(0, maxBytes);
  let out = buffer.subarray(0, end).toString('utf8').replace(/�+$/, '');
  while (byteLength(out) > maxBytes && end > 0) {
    end -= 1;
    out = buffer.subarray(0, end).toString('utf8').replace(/�+$/, '');
  }
  return out;
}

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return !sample.includes(0);
}

function fence(text) {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const marks = '`'.repeat(Math.max(3, longestRun + 1));
  return `${marks}\n${text}\n${marks}`;
}

function section(title, body) {
  return [`## ${title}`, '', body.trim() ? body.trimEnd() : '(none)', ''].join('\n');
}

function isSensitive(file, globs) {
  if (!globs.length) return false;
  return matchesAny(file, globs) || matchesAny(`/${file}`, globs);
}

export function ensureGitRepository(cwd) {
  if (!cwd || !fs.existsSync(cwd)) {
    throw new OpcError('GIT_FAILED', 'Falha ao executar git rev-parse: caminho de trabalho inexistente ou inválido.', { exitCode: ExitCode.USAGE });
  }
  const result = git(cwd, ['rev-parse', '--show-toplevel']);
  if (result.error?.code === 'ENOENT') throw new UsageError('GIT_MISSING', 'O git não está instalado. Instale o Git e tente novamente.');
  if (result.error || result.status !== 0) {
    if (!result.error && result.status === 128 && /not a git repository/i.test(result.stderr ?? '')) {
      throw new UsageError('NOT_A_GIT_REPO', 'Este comando precisa ser executado dentro de um repositório Git.');
    }
    throw gitFailure(['rev-parse'], result, cwd);
  }
  return result.stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (symbolic.status === 0) {
    const ref = symbolic.stdout.trim();
    if (ref.startsWith('refs/remotes/origin/')) {
      const branch = ref.slice('refs/remotes/origin/'.length);
      const local = git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
      if (local.status === 0) return branch;
      if (local.status !== 1 || local.error || local.stderr) throw gitFailure(['show-ref'], local, cwd);
      const remote = git(cwd, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
      if (remote.status === 0) return `origin/${branch}`;
      if (remote.status !== 1 || remote.error || remote.stderr) throw gitFailure(['show-ref'], remote, cwd);
    }
  } else if (symbolic.status !== 1 || symbolic.error || symbolic.stderr) {
    throw gitFailure(['symbolic-ref'], symbolic, cwd);
  }
  for (const candidate of ['main', 'master', 'trunk']) {
    const local = git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`]);
    if (local.status === 0) return candidate;
    if (local.status !== 1 || local.error || local.stderr) throw gitFailure(['show-ref'], local, cwd);
    const remote = git(cwd, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) return `origin/${candidate}`;
    if (remote.status !== 1 || remote.error || remote.stderr) throw gitFailure(['show-ref'], remote, cwd);
  }
  throw new UsageError(
    'NO_DEFAULT_BRANCH',
    'Não foi possível detectar a branch padrão do repositório. Informe --base <valor> ou use --scope working-tree.',
  );
}

function currentBranch(root) {
  return gitChecked(root, ['branch', '--show-current']).trim() || 'HEAD';
}

function assertBaseRef(root, ref) {
  if (typeof ref !== 'string' || !ref.trim() || ref.startsWith('-')) {
    throw new UsageError('INVALID_BASE', `Referência base inválida "${String(ref).slice(0, 12)}…".`);
  }
  const result = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (result.error || (result.status !== 0 && (result.status !== 1 || result.stderr))) {
    throw gitFailure(['rev-parse'], result, root);
  }
  if (result.status !== 0) {
    throw new UsageError('UNKNOWN_BASE', `Referência base desconhecida "${String(ref).slice(0, 12)}…". Informe uma branch, tag ou commit existente em --base.`);
  }
}

function getWorkingTreeState(root) {
  const staged = splitNul(gitChecked(root, ['diff', '--cached', '--name-only', '-z']));
  const unstaged = splitNul(gitChecked(root, ['diff', '--name-only', '-z']));
  const untracked = splitNul(gitChecked(root, ['ls-files', '--others', '--exclude-standard', '-z']));
  return { staged, unstaged, untracked, isDirty: staged.length + unstaged.length + untracked.length > 0 };
}

export function resolveReviewTarget(cwd, { base = null, scope = 'auto' } = {}) {
  const root = ensureGitRepository(cwd);
  const requested = scope ?? 'auto';
  if (base) {
    assertBaseRef(root, base);
    return { mode: 'branch', label: `diff da branch em relação a ${base}`, baseRef: base, explicit: true };
  }
  if (!SUPPORTED_SCOPES.has(requested)) {
    throw new UsageError(
      'INVALID_SCOPE',
      `Escopo de revisão não suportado "${String(requested).slice(0, 12)}…". Use auto, working-tree, branch ou informe --base <valor>.`,
    );
  }
  if (requested === 'working-tree') return { mode: 'working-tree', label: 'diff da árvore de trabalho', explicit: true };
  if (requested === 'branch') {
    const detected = detectDefaultBranch(root);
    return { mode: 'branch', label: `diff da branch em relação a ${detected}`, baseRef: detected, explicit: true };
  }
  if (getWorkingTreeState(root).isDirty) return { mode: 'working-tree', label: 'diff da árvore de trabalho', explicit: false };
  const detected = detectDefaultBranch(root);
  return { mode: 'branch', label: `diff da branch em relação a ${detected}`, baseRef: detected, explicit: false };
}

function formatUntrackedFile(root, rel) {
  const absolute = path.join(root, rel);
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    return `### ${rel}\n(ignorado: arquivo ilegível)`;
  }
  if (stat.isSymbolicLink()) return `### ${rel}\n(ignorado: link simbólico)`;
  if (stat.isDirectory()) return `### ${rel}\n(ignorado: diretório)`;
  if (!stat.isFile()) return `### ${rel}\n(ignorado: não é um arquivo comum)`;
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${rel}\n(ignorado: ${stat.size} bytes excedem o limite de ${MAX_UNTRACKED_BYTES} bytes; leia com a ferramenta read)`;
  }
  let buffer;
  try {
    buffer = fs.readFileSync(absolute);
  } catch {
    return `### ${rel}\n(ignorado: arquivo ilegível)`;
  }
  if (!isProbablyText(buffer)) return `### ${rel}\n(ignorado: arquivo binário)`;
  return `### ${rel}\n${fence(buffer.toString('utf8').trimEnd())}`;
}

function measureOutput(root, args, limit) {
  const result = git(root, args, { maxBuffer: limit + 1 });
  if (result.error?.code === 'ENOBUFS') return { bytes: limit + 1, text: null };
  if (result.error || result.status !== 0) throw gitFailure(args, result, root);
  const size = byteLength(result.stdout);
  return size > limit ? { bytes: size, text: null } : { bytes: size, text: result.stdout };
}

function trackedEntry(root, file, argSets, limit) {
  let text = '';
  let size = 0;
  for (const args of argSets) {
    const measured = measureOutput(root, args, Math.max(0, limit - size));
    size += measured.bytes;
    if (measured.text === null) return { file, kind: 'tracked', text: null, bytes: size };
    text += measured.text;
  }
  return { file, kind: 'tracked', text, bytes: size };
}

function workingTreeEntries(root, state, excludeGlobs, limit) {
  const staged = new Set(state.staged);
  const unstaged = new Set(state.unstaged);
  const untracked = new Set(state.untracked);
  const entries = [];
  const excluded = [];
  for (const file of uniqueSorted(state.staged, state.unstaged, state.untracked)) {
    if (isSensitive(file, excludeGlobs)) {
      excluded.push(file);
    } else if (untracked.has(file)) {
      const text = formatUntrackedFile(root, file);
      entries.push({ file, kind: 'untracked', text, bytes: byteLength(text) });
    } else {
      const argSets = [];
      if (staged.has(file)) argSets.push([...DIFF_BASE, '--cached', '--', file]);
      if (unstaged.has(file)) argSets.push([...DIFF_BASE, '--', file]);
      entries.push(trackedEntry(root, file, argSets, limit));
    }
  }
  return { entries, excluded };
}

function branchEntries(root, range, files, excludeGlobs, limit) {
  const entries = [];
  const excluded = [];
  for (const file of files) {
    if (isSensitive(file, excludeGlobs)) excluded.push(file);
    else entries.push(trackedEntry(root, file, [[...DIFF_BASE, range, '--', file]], limit));
  }
  return { entries, excluded };
}

function assembleContext({ inlineHead, chunkedHead, fallbackHead, fallbackShortstat = '', fallbackNames = [], statBytes = 0, inlineSections, entries, excluded, max }) {
  const diffBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
  const renderFileList = (files, byteLimit) => {
    const lines = [];
    for (const file of files) {
      const candidate = [...lines, file].join('\n');
      if (byteLength(candidate) > byteLimit) break;
      lines.push(file);
    }
    if (lines.length < files.length) {
      const marker = `e mais ${files.length - lines.length} arquivos`;
      while (lines.length && byteLength([...lines, marker].join('\n')) > byteLimit) lines.pop();
      lines.push(`e mais ${files.length - lines.length} arquivos`);
    }
    return lines.join('\n') || '(none)';
  };
  const excludedBody = renderFileList(excluded, Math.min(OMITTED_LIST_BYTES, Math.floor(max * 0.2)));
  const excludedSections = excluded.length
    ? [section('Arquivos excluídos (policy.sensitivePaths)', excludedBody)]
    : [];
  const inlineContent = [...inlineHead, ...inlineSections(entries), excluded.length ? section('Arquivos excluídos (policy.sensitivePaths)', excluded.join('\n')) : ''].filter(Boolean).join('\n');
  if (entries.every((entry) => entry.text !== null) && diffBytes <= max && byteLength(inlineContent) <= max) {
    return {
      content: inlineContent,
      truncated: false,
      inputMode: 'inline-diff',
      guidance: INLINE_GUIDANCE,
      diffBytes,
      includedFiles: entries.map((entry) => entry.file),
      omittedFiles: [],
    };
  }

  const statFallback = statBytes > Math.floor(max * 0.6);
  const filenameSection = section(
    'Arquivos alterados',
    renderFileList(fallbackNames, Math.min(OMITTED_LIST_BYTES, Math.floor(max * 0.2))),
  );
  const summarizedHead = [
    ...fallbackHead,
    section('Estatísticas resumidas', fallbackShortstat || '(none)'),
    filenameSection,
  ];
  const withoutStatusAndLog = (sections) => sections.filter(
    (item) => !item.startsWith('## Status do Git\n') && !item.startsWith('## Log de commits\n'),
  );
  const initialHead = statFallback
    ? summarizedHead
    : chunkedHead;
  const levels = [
    initialHead,
    withoutStatusAndLog(initialHead),
    summarizedHead,
    summarizedHead.filter((item) => !item.startsWith('## Arquivos alterados\n')),
  ];
  const sorted = [...entries].sort(
    (a, b) => Number(a.text === null) - Number(b.text === null) || a.bytes - b.bytes || a.file.localeCompare(b.file),
  );
  const diffTitle = section('Diffs por arquivo (menores primeiro)', '(none)');
  const omittedByteLimit = Math.min(OMITTED_LIST_BYTES, Math.floor(max * 0.2));
  let selected;
  for (const level of levels) {
    const head = [...level, ...excludedSections].filter(Boolean).join('\n');
    const included = [];
    let omitted = [...sorted];
    const buildContent = () => {
      const omittedBody = renderFileList(omitted.map((entry) => entry.file), omittedByteLimit);
      return [
        head,
        included.length ? section('Diffs por arquivo (menores primeiro)', included.map((entry) => entry.block).join('\n')) : diffTitle,
        section('Arquivos omitidos', omittedBody),
      ].filter(Boolean).join('\n');
    };

    let content = buildContent();
    if (byteLength(content) > max) continue;
    for (let index = 0; index < sorted.length; index += 1) {
      const entry = sorted[index];
      if (entry.text === null) break;
      const candidate = { ...entry, block: `### ${entry.file}\n${entry.text}` };
      included.push(candidate);
      omitted = sorted.slice(index + 1);
      const nextContent = buildContent();
      if (byteLength(nextContent) > max) {
        included.pop();
        omitted = sorted.slice(index);
        break;
      }
      content = nextContent;
    }
    selected = { content, included, omitted };
    break;
  }
  if (!selected) {
    throw new OpcError(
      'REVIEW_CONTEXT_LIMIT',
      `O contexto de revisão excede o limite configurado de ${max} bytes.`,
      { exitCode: ExitCode.USAGE },
    );
  }
  return {
    content: selected.content,
    truncated: true,
    inputMode: 'chunked',
    guidance: CHUNKED_GUIDANCE,
    diffBytes,
    includedFiles: selected.included.map((entry) => entry.file),
    omittedFiles: selected.omitted.map((entry) => entry.file),
  };
}

function collectWorkingTree(root, max, excludeGlobs) {
  const state = getWorkingTreeState(root);
  const files = uniqueSorted(state.staged, state.unstaged, state.untracked);
  const status = gitChecked(root, ['status', '--short', '--untracked-files=all']);
  const { entries, excluded } = workingTreeEntries(root, state, excludeGlobs, max);
  const stat = [
    gitChecked(root, ['diff', '--cached', '--stat=10000']).trimEnd(),
    gitChecked(root, ['diff', '--stat=10000']).trimEnd(),
    state.untracked.map((file) => `${file} (untracked)`).join('\n'),
  ]
    .filter(Boolean)
    .join('\n');
  const shortstat = [
    gitChecked(root, ['diff', '--cached', '--shortstat']).trim(),
    gitChecked(root, ['diff', '--shortstat']).trim(),
  ].filter(Boolean).join('\n');
  const assembled = assembleContext({
    inlineHead: [section('Status do Git', status)],
    chunkedHead: [section('Status do Git', status), section('Estatísticas do diff', stat)],
    fallbackHead: [section('Aviso', 'As estatísticas detalhadas foram resumidas para caber no limite.')],
    fallbackShortstat: shortstat,
    fallbackNames: files,
    statBytes: byteLength(stat),
    inlineSections: (all) => [
      section('Diff', all.filter((entry) => entry.kind === 'tracked').map((entry) => entry.text).join('')),
      section('Arquivos não rastreados', all.filter((entry) => entry.kind === 'untracked').map((entry) => entry.text).join('\n\n')),
    ],
    entries,
    excluded,
    max,
  });
  return {
    mode: 'working-tree',
    summary: `Revisando ${state.staged.length} arquivo(s) staged, ${state.unstaged.length} unstaged e ${state.untracked.length} não rastreado(s).`,
    files,
    excludedFiles: excluded,
    ...assembled,
  };
}

function collectBranch(root, baseRef, max, excludeGlobs) {
  const mergeBase = gitChecked(root, ['merge-base', 'HEAD', baseRef]).trim();
  const range = `${mergeBase}..HEAD`;
  const files = splitNul(gitChecked(root, ['diff', '--name-only', '-z', range]));
  const log = gitChecked(root, ['log', '--oneline', '--decorate', range]);
  const stat = gitChecked(root, ['diff', '--stat=10000', range]);
  const shortstat = gitChecked(root, ['diff', '--shortstat', range]).trim();
  const { entries, excluded } = branchEntries(root, range, files, excludeGlobs, max);
  const head = [section('Log de commits', log), section('Estatísticas do diff', stat)];
  const assembled = assembleContext({
    inlineHead: head,
    chunkedHead: head,
    fallbackHead: [section('Aviso', 'As estatísticas detalhadas foram resumidas para caber no limite.')],
    fallbackShortstat: shortstat,
    fallbackNames: files,
    statBytes: byteLength(stat),
    inlineSections: (all) => [section('Diff da branch', all.map((entry) => entry.text).join(''))],
    entries,
    excluded,
    max,
  });
  return {
    mode: 'branch',
    summary: `Revisando a branch ${currentBranch(root)} em relação a ${baseRef}, a partir do merge-base ${mergeBase}.`,
    files,
    excludedFiles: excluded,
    ...assembled,
  };
}

export function collectReviewContext(cwd, target, { maxInlineBytes = DEFAULT_MAX_INLINE_BYTES, excludeGlobs = [] } = {}) {
  const root = ensureGitRepository(cwd);
  const max = Number.isFinite(maxInlineBytes) && maxInlineBytes > 0 ? Math.floor(maxInlineBytes) : DEFAULT_MAX_INLINE_BYTES;
  const details = target.mode === 'branch'
    ? collectBranch(root, target.baseRef, max, excludeGlobs)
    : collectWorkingTree(root, max, excludeGlobs);
  return { repoRoot: root, branch: currentBranch(root), target, ...details };
}

export function parseShortstat(text) {
  const pick = (pattern) => Number((String(text ?? '').match(pattern) ?? [])[1] ?? 0);
  return {
    files: pick(/(\d+) files? changed/),
    insertions: pick(/(\d+) insertions?\(\+\)/),
    deletions: pick(/(\d+) deletions?\(-\)/),
  };
}

function countTextLines(absolute) {
  try {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.size > MAX_LINECOUNT_BYTES) return 0;
    const buffer = fs.readFileSync(absolute);
    if (!isProbablyText(buffer)) return 0;
    const text = buffer.toString('utf8');
    if (!text) return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch {
    return 0;
  }
}

export function diffSizeEstimate(cwd, target) {
  const root = ensureGitRepository(cwd);
  if (target.mode === 'branch') {
    const mergeBase = gitChecked(root, ['merge-base', 'HEAD', target.baseRef]).trim();
    return parseShortstat(gitChecked(root, ['diff', '--shortstat', `${mergeBase}..HEAD`]));
  }
  const state = getWorkingTreeState(root);
  const cached = parseShortstat(gitChecked(root, ['diff', '--cached', '--shortstat']));
  const unstaged = parseShortstat(gitChecked(root, ['diff', '--shortstat']));
  const untrackedLines = state.untracked.reduce((total, file) => total + countTextLines(path.join(root, file)), 0);
  return {
    files: uniqueSorted(state.staged, state.unstaged, state.untracked).length,
    insertions: cached.insertions + unstaged.insertions + untrackedLines,
    deletions: cached.deletions + unstaged.deletions,
  };
}
