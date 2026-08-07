export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // 项目使用 feat/fix/docs/refactor/test/chore/eval
    'type-enum': [2, 'always', ['feat', 'fix', 'docs', 'refactor', 'test', 'chore', 'eval']],
    // 允许 + 连接的多 scope（如 cli+hooks, schemas+pkg）
    'scope-case': [0],
  },
};
