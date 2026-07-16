import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const rootDir = path.resolve('.');
const brainstormingDir = path.join(rootDir, 'skills/core/brainstorming');
const governanceReference = path.join(rootDir, 'docs/inventory/governance-reference-analysis.md');

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function forbiddenTerms() {
  return [
    ['super', 'powers'].join(''),
    ['obra', '/', 'super', 'powers'].join(''),
    ['.', 'super', 'powers'].join(''),
    ['SUPER', 'POWERS', '_'].join(''),
    ['Prime', ' ', 'Radiant'].join(''),
    ['primeradiant', '.', 'com'].join(''),
  ];
}

test('brainstorming assets contain no external provenance or legacy paths', async () => {
  const files = [...await collectFiles(brainstormingDir), governanceReference];
  const terms = forbiddenTerms();
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    for (const term of terms) {
      assert.equal(content.toLowerCase().includes(term.toLowerCase()), false, `${file} contains ${term}`);
    }
  }
});

test('brainstorming paths and branding are project-local and generic', async () => {
  const [skill, visualGuide, startScript, server, frame] = await Promise.all([
    readFile(path.join(brainstormingDir, 'SKILL.md'), 'utf8'),
    readFile(path.join(brainstormingDir, 'visual-companion.md'), 'utf8'),
    readFile(path.join(brainstormingDir, 'scripts/start-server.sh'), 'utf8'),
    readFile(path.join(brainstormingDir, 'scripts/server.cjs'), 'utf8'),
    readFile(path.join(brainstormingDir, 'scripts/frame-template.html'), 'utf8'),
  ]);

  assert.match(skill, /docs\/specs\/YYYY-MM-DD-<topic>-design\.md/u);
  assert.match(visualGuide, /\.loopengine\/brainstorm/u);
  assert.match(startScript, /\.loopengine\/brainstorm/u);
  assert.match(server, /Brainstorm Companion/u);
  assert.doesNotMatch(server, /https:\/\//u);
  assert.doesNotMatch(frame, /brand-logo/u);
});
