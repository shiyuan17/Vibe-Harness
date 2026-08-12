export function normalizeAstGrepArgs(input) {
  const command = input[0];
  return command === 'sg' || command === 'ast-grep' ? input.slice(1) : [...input];
}
