#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(toolDir, 'node_modules/@agentmemory/mcp/bin.mjs')));
