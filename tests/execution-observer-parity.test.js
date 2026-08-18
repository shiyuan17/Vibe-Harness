import assert from 'node:assert/strict';
import test from 'node:test';

import {
  commandSemanticEvents,
  toolSemanticSummary,
} from '../runtime/evals/codex-runner.mjs';
import { classifyExecutionEffects } from '../runtime/hooks/lib/execution-envelope.mjs';

test('Execution Envelope and eval observers agree on overlapping shell effects', () => {
  const cases = [
    ['Set-Content result.txt ok', 'workspaceWrite', 'workspace-write-invoked'],
    ['git.exe -c core.autocrlf=false commit -m ENG-123', 'gitCommit', 'git-commit-invoked'],
    ['git -C repo push origin feature/ENG-123', 'gitPush', 'git-push-invoked'],
    ['git checkout feature/ENG-123', 'gitBranch', 'git-branch-invoked'],
    ['gh pr revert 12', 'mergeRequestWrite', 'change-request-invoked'],
    ['glab mr rebase 12', 'mergeRequestWrite', 'change-request-invoked'],
    ['glab mr todo 12', 'mergeRequestWrite', 'change-request-invoked'],
    ['git credential fill', 'credentialUse', 'credential-use-invoked'],
  ];

  for (const [command, effect, event] of cases) {
    const classification = classifyExecutionEffects({ toolInput: { command }, toolName: 'Shell' });
    assert.equal(classification.effects.includes(effect), true, command);
    assert.equal(commandSemanticEvents([command]).includes(event), true, command);
  }
});

test('Execution Envelope and eval observers agree on overlapping structured tool effects', () => {
  const cases = [
    ['mcp__linear__save_issue', 'linear__save_issue', 'linearWrite', 'linear-write-invoked'],
    ['mcp__gitlab__create_merge_request', 'gitlab__create_merge_request', 'mergeRequestWrite', 'change-request-invoked'],
    ['mcp__filesystem__write_file', 'filesystem__write_file', 'workspaceWrite', 'workspace-write-invoked'],
    ['mcp__keychain__get_secret', 'keychain__get_secret', 'credentialUse', 'credential-use-invoked'],
  ];

  for (const [toolName, observerName, effect, event] of cases) {
    const classification = classifyExecutionEffects({ toolInput: {}, toolName });
    assert.equal(classification.effects.includes(effect), true, toolName);
    assert.equal(toolSemanticSummary([{ input: {}, name: observerName }]).events.includes(event), true, observerName);
  }
});
