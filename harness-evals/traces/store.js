import path from 'node:path';

import { writeTraceBundle } from './atif.js';

function portable(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/gu, '-').slice(0, 160);
}

export function createFileTraceStore(rootDir) {
  if (!path.isAbsolute(rootDir ?? '')) throw new TypeError('trace root must be absolute');
  return Object.freeze({
    async write({ execution, attempt, trace }) {
      const relativeDirectory = path.join(portable(execution.scenario.id), portable(execution.executionId), portable(attempt.id));
      const directory = path.join(rootDir, relativeDirectory);
      const refs = await writeTraceBundle(directory, {
        trace,
        events: attempt.events,
        artifacts: attempt.observation?.artifacts ?? [],
      });
      return Object.fromEntries(Object.entries(refs).map(([key, value]) => [
        key,
        path.join(relativeDirectory, value).replaceAll('\\', '/'),
      ]));
    },
  });
}
