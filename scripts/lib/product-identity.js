export const productIdentity = Object.freeze({
  agentRuntimeDir: '.agents/cognis',
  chineseName: '智序',
  command: 'cognis',
  configFile: 'cognis.config.json',
  managedMarker: 'COGNIS',
  name: 'Cognis',
  packageName: '@jw/cognis',
  stateDir: '.cognis',
  legacy: Object.freeze({
    agentRuntimeDir: '.agents/loopengine',
    command: 'loopengine',
    configFile: 'loopengine.config.json',
    managedMarker: 'LOOPENGINE',
    name: 'LoopEngine',
    packageName: '@jw/loopengine',
    stateDir: '.loopengine',
  }),
});

export function readProductEnv(env, suffix) {
  const canonicalName = `COGNIS_${suffix}`;
  if (env[canonicalName] !== undefined) {
    return { deprecated: false, name: canonicalName, value: env[canonicalName] };
  }
  const legacyName = `LOOPENGINE_${suffix}`;
  if (env[legacyName] !== undefined) {
    return { deprecated: true, name: legacyName, value: env[legacyName] };
  }
  return { deprecated: false, name: canonicalName, value: undefined };
}
