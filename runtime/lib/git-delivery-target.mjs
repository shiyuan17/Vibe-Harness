import { execFileSync } from 'node:child_process';

export const isProtectedDeliveryRef = (ref) => /^(?:refs\/heads\/)?(?:main|master|release)(?:$|[/-])/iu.test(ref);

/** Resolve exactly one configured push endpoint; never guess fetch == push. */
export function resolveGitPushTarget(cwd, args) {
  const git = (values) => {
    try { return execFileSync('git', values, { cwd, encoding: 'utf8', windowsHide: true,
      timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { return ''; }
  };
  const branch = git(['branch', '--show-current']);
  if (!branch || isProtectedDeliveryRef(branch)) return null;
  const remotes = git(['remote']).split(/\r?\n/u).filter(Boolean);
  let remote, destination, sha = git(['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!sha) return null;
  if (args[0] === '--no-force') {
    if (args.length !== 3) return null;
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}):(refs\/heads\/.+)$/u.exec(args[2]);
    if (!match || match[1] !== sha || match[2] !== `refs/heads/${branch}`) return null;
    const matches = remotes.filter((name) =>
      git(['remote', 'get-url', '--push', '--all', name]) === args[1]);
    if (matches.length !== 1) return null;
    [remote] = matches;
    destination = match[2];
  } else if (!args.length) {
    const mode = git(['config', '--get', 'push.default']);
    if (mode && !['simple', 'upstream', 'current'].includes(mode)) return null;
    remote = git(['config', '--get', `branch.${branch}.remote`]);
    destination = git(['config', '--get', `branch.${branch}.merge`]);
    if (destination !== `refs/heads/${branch}`) return null;
    const pushDefault = git(['config', '--get', 'remote.pushDefault']);
    const branchDefault = git(['config', '--get', `branch.${branch}.pushRemote`]);
    if (pushDefault && pushDefault !== remote || branchDefault && branchDefault !== remote) return null;
  } else {
    const values = ['-u', '--set-upstream'].includes(args[0]) ? args.slice(1) : args;
    if (values.length !== 2 || values[1] !== branch) return null;
    [remote] = values;
    destination = `refs/heads/${branch}`;
  }
  if (!remotes.includes(remote) || remote === '.') return null;
  const urls = git(['remote', 'get-url', '--push', '--all', remote]).split(/\r?\n/u).filter(Boolean);
  if (urls.length !== 1 || git(['config', '--get-all', `remote.${remote}.push`])
    || git(['config', '--get', `remote.${remote}.mirror`]) === 'true'
    || git(['config', '--get', 'push.followTags']) === 'true') return null;
  return { remote, url: urls[0], ref: destination, sha, branch };
}
