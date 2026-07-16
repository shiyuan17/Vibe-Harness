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
  const skill = await readFile(path.join(brainstormingDir, 'SKILL.md'), 'utf8');
  const files = await collectFiles(brainstormingDir);

  assert.match(skill, /docs\/specs\/YYYY-MM-DD-<topic>-design\.md/u);
  assert.doesNotMatch(skill, /visual companion|浏览器辅助/u);
  assert.equal(files.some((file) => file.includes('visual-companion') || file.includes(`${path.sep}scripts${path.sep}`)), false);
});
