// Literal permission rules expected for F2A_POLICY (tests/helpers.mjs), spec §8.1, in send order.
const r = (action, resource, effect) => ({ action, resource, effect });

const SENSITIVE = ['*.env', '**/.ssh/**'].flatMap((p) => ['read', 'grep', 'glob'].map((perm) => r(perm, p, 'deny')));
const INVARIANTS_HEAD = [r('external_directory', '*', 'deny'), ...SENSITIVE, r('subagent', 'work-*', 'deny'), r('gitlab_*', '*', 'deny')];
const DESTRUCTIVE = [
  'rm -rf*', 'rm -r *', 'rm -fr*', 'git push --force*', 'git push -f*', 'git push --delete*',
  'git reset --hard*', 'git clean -f*', 'git branch -D*', 'git tag -d*', 'docker rm*',
  'docker rmi*', 'docker volume rm*', 'docker system prune*', 'docker compose down -v*',
  'kubectl delete*', 'mkfs*', 'dd *of=*', 'shred*', 'truncate -s 0*', 'find * -delete*',
  'shutdown*', 'reboot*', 'poweroff*', 'systemctl stop*', '*DROP DATABASE*', '*DROP TABLE*',
  '*TRUNCATE*', 'make nuke*',
].map((p) => r('shell', p, 'ask'));
const READ_ONLY_BASE = [
  r('*', '*', 'deny'),
  r('read', '*', 'allow'), r('glob', '*', 'allow'), r('skill', '*', 'allow'), r('question', '*', 'allow'),
];
const READ_ONLY_INVARIANTS_HEAD = [INVARIANTS_HEAD[0], r('grep', '*', 'deny'), ...INVARIANTS_HEAD.slice(1)];

export const READ_ONLY_RULES = [...READ_ONLY_BASE, ...READ_ONLY_INVARIANTS_HEAD, r('browser', '*', 'deny')];
export const WRITE_RULES = [...INVARIANTS_HEAD, ...DESTRUCTIVE, r('browser', '*', 'deny')];
export const NPM_TEST_ONLY_RULES = [...READ_ONLY_BASE, r('shell', 'npm test', 'allow'), ...READ_ONLY_INVARIANTS_HEAD, ...DESTRUCTIVE, r('browser', '*', 'deny')];
