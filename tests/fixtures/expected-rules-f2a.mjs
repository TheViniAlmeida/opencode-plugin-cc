// Literal permission rules expected for F2A_POLICY (tests/helpers.mjs), spec §8.1, in send order.
const r = (permission, pattern, action) => ({ permission, pattern, action });

const SENSITIVE = ['*.env', '**/.ssh/**'].flatMap((p) => ['read', 'grep', 'glob', 'list'].map((perm) => r(perm, p, 'deny')));
const INVARIANTS_HEAD = [r('external_directory', '*', 'deny'), ...SENSITIVE, r('task', 'work-*', 'deny'), r('gitlab_*', '*', 'deny')];
const DESTRUCTIVE = [
  'rm -rf*', 'rm -r *', 'rm -fr*', 'git push --force*', 'git push -f*', 'git push --delete*',
  'git reset --hard*', 'git clean -f*', 'git branch -D*', 'git tag -d*', 'docker rm*',
  'docker rmi*', 'docker volume rm*', 'docker system prune*', 'docker compose down -v*',
  'kubectl delete*', 'mkfs*', 'dd *of=*', 'shred*', 'truncate -s 0*', 'find * -delete*',
  'shutdown*', 'reboot*', 'poweroff*', 'systemctl stop*', '*DROP DATABASE*', '*DROP TABLE*',
  '*TRUNCATE*', 'make nuke*',
].map((p) => r('bash', p, 'ask'));
const READ_ONLY_BASE = [
  r('*', '*', 'deny'),
  r('read', '*', 'allow'), r('glob', '*', 'allow'), r('list', '*', 'allow'),
  r('lsp', '*', 'allow'), r('skill', '*', 'allow'), r('todowrite', '*', 'allow'),
];
const READ_ONLY_INVARIANTS_HEAD = [INVARIANTS_HEAD[0], r('grep', '*', 'deny'), ...INVARIANTS_HEAD.slice(1)];

export const READ_ONLY_RULES = [...READ_ONLY_BASE, ...READ_ONLY_INVARIANTS_HEAD, r('doom_loop', '*', 'deny')];
export const WRITE_RULES = [...INVARIANTS_HEAD, ...DESTRUCTIVE, r('doom_loop', '*', 'ask')];
export const NPM_TEST_ONLY_RULES = [...READ_ONLY_BASE, r('bash', 'npm test', 'allow'), ...READ_ONLY_INVARIANTS_HEAD, ...DESTRUCTIVE, r('doom_loop', '*', 'deny')];
