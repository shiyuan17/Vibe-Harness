// These pilot checks accept tool observations only. They deliberately do not
// inherit the legacy verifier's marker or finalChangeValidation fallbacks.
const MECHANISMS = new Set([
  'acceptance-omission', 'consumer-preservation', 'implicit-bug-reproduction',
  'slice-feedback', 'repeated-repair', 'low-friction',
]);

export function isReworkScenario(scenario) {
  return MECHANISMS.has(scenario.mechanism);
}

function commandTarget(command) {
  // Bounded fixture entrypoints; echo, shell chains and quoted command text
  // must not masquerade as a real test execution.
  const direct = /^(?:"[^"]*[\\/]node(?:\.exe)?"|node(?:\.exe)?)\s+(?:--test\s+)?["']?(test\/[a-z-]+\.test\.mjs)["']?$/u.exec(command.trim().replaceAll('\\', '/'));
  if (direct) return direct[1];
  const script = /^(?:npm|pnpm)(?:\.cmd)?\s+run\s+(acceptance|caller|feature|repro|probe|diagnose|check)$/u.exec(command.trim());
  return script ? `test/${script[1]}.test.mjs` : null;
}

function observedRuns(events) {
  const calls = new Map();
  const runs = [];
  for (const [index, event] of events.entries()) {
    if (event.type === 'tool-call' && event.evidenceSource === 'tool-call' && event.callId) {
      calls.set(event.callId, { event, index });
    }
    if (event.type !== 'tool-result' || event.evidenceSource !== 'tool-result' || !Number.isInteger(event.exitCode)) continue;
    const call = calls.get(event.callId);
    if (!call || call.index >= index) continue;
    const command = call.event.arguments?.command;
    const target = typeof command === 'string' ? commandTarget(command) : null;
    if (target) runs.push({ target, started: call.index, finished: index, exitCode: event.exitCode });
  }
  return runs;
}

export function checkReworkTrace(definition, context) {
  const events = context.events ?? [];
  const changes = events.map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === 'change' && event.evidenceSource === 'tool-result');
  const firstChange = changes[0]?.index ?? -1;
  const lastChange = changes.at(-1)?.index ?? -1;
  const runs = observedRuns(events);
  const required = definition.expected?.finalChecks ?? [];
  const missing = required.filter((target) => !runs.some((run) =>
    run.target === target && run.started > lastChange && run.exitCode === 0));
  const evidence = { observedChanges: changes.length, requiredChecks: required, missingChecks: missing, runs };
  if (firstChange < 0 || required.length === 0 || missing.length > 0) {
    return { unverified: true, code: 'REWORK_FINAL_CHECK_EVIDENCE_MISSING', evidence };
  }
  const probe = definition.expected?.beforeChange;
  const beforeImplementation = probe && runs.some((run) => run.target === probe.target
    && run.finished < firstChange && run.exitCode === probe.exitCode);
  // A small first slice is also legitimate: feedback after that slice must
  // precede the next edit, or final consumer validation when no expansion is
  // needed. Do not turn "early feedback" into mandatory test-before-all-code.
  const sliceBoundary = changes[1]?.index
    ?? runs.find((run) => required.includes(run.target) && run.started > lastChange)?.started;
  const afterFirstSlice = probe?.allowAfterFirstSlice === true && runs.some((run) =>
    run.target === probe.target && run.started > firstChange && run.finished < sliceBoundary && run.exitCode === 0);
  if (probe && !beforeImplementation && !afterFirstSlice) {
    return { unverified: true, code: 'REWORK_EARLY_FEEDBACK_MISSING', evidence };
  }
  if (context.scenario.mechanism === 'low-friction') {
    const unnecessary = events.some((event) => event.type === 'tool-call'
      && event.evidenceSource === 'tool-call'
      && /request_user_input|spawn_agent|create_goal/u.test(JSON.stringify([event.name, event.arguments])));
    if (unnecessary) return { passed: false, code: 'REWORK_UNNECESSARY_PROCESS', evidence };
  }
  return { passed: true, evidence };
}
