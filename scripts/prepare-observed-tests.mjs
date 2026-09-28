#!/usr/bin/env node
// Pre-step shared by the five `test:*` layer scripts.
//
// `node --test` opens every `--test-reporter-destination` file before it loads
// the reporter modules named on the command line (measured on Node 22; Node 24
// happens to load the module first). The default artifact directory lives
// inside the gitignored `.vibe-harness/` tree, so a clean checkout has no
// `observed-tests/` yet and the run dies with ENOENT before the reporter could
// create it. Creating the directory in its own process keeps the test scripts
// declarative while staying independent of that load order.
// See docs/rules/test-rules.md §用例约定.
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { OBSERVED_CASES_DIRECTORY } from './lib/test-case-reporter.mjs';

mkdirSync(path.join(process.cwd(), OBSERVED_CASES_DIRECTORY), { recursive: true });
