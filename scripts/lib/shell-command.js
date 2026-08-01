/**
 * Shared command-tokenisation and shell-safety helpers.
 *
 * `splitCommand` performs quote-aware whitespace tokenisation without invoking a
 * shell. `assertSafeCommand` additionally rejects shell control metacharacters
 * so that a malicious validation/runner command (e.g. from a crafted project
 * config) cannot smuggle shell control flow past `execFile`/`spawn` with
 * `shell:false`.
 *
 * Design notes:
 * - All callers use `execFile`/`spawn` with `shell:false`, which prevents shell
 *   interpretation entirely. The metacharacter check is defence-in-depth.
 * - The check runs **after** tokenisation so that quoted arguments (e.g.
 *   `node -e "console.log(42)"`) are not falsely rejected for parentheses or
 *   angle brackets that are legitimate inside a quoted program argument. Once
 *   tokenised, each bare token is checked for shell control sequences that
 *   could alter command flow: command chaining (`;`, `&&`, `||`, `|`, `&`),
 *   redirections (`>`, `<`), and command substitution (`$(`, backticks).
 * - Backslash (`\`) is never flagged because it is a legitimate Windows path
 *   separator and is harmless under `shell:false`.
 */

// Shell control sequences that could alter command flow if a token were ever
// passed to a shell. We check for these on individual tokens (post-quotes) so
// quoted program arguments like `"console.log(42)"` are not falsely rejected.
const shellControlPattern = /(?:&&|\|\||[;|&<>`$])|\$\(/u;

/**
 * Tokenise a command string into `[program, ...args]` using simple quote-aware
 * splitting. Supports double-quoted, single-quoted, and bare whitespace-delimited
 * tokens. Throws if the command is empty or contains only whitespace.
 *
 * @param {string} command - The raw command string.
 * @param {string} [emptyMessage='Command is empty.'] - Error message when empty.
 * @returns {string[]} Tokens, where tokens[0] is the program name.
 */
export function splitCommand(command, emptyMessage = 'Command is empty.') {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/gu;
  for (const match of command.matchAll(pattern)) tokens.push(match[1] ?? match[2] ?? match[3]);
  if (tokens.length === 0) throw new Error(emptyMessage);
  return tokens;
}

/**
 * Reject commands containing shell control sequences, then return tokens.
 *
 * Tokenisation is performed first so that quoted arguments (e.g.
 * `"console.log(42)"`) are evaluated as a single token — the parentheses inside
 * are legitimate program input, not shell syntax. After tokenisation each token
 * is checked for shell control sequences (`;`, `&&`, `||`, `|`, `&`, `>`, `<`,
 * backticks, `$(`) that could alter command flow.
 *
 * Even though callers use `execFile`/`spawn` with `shell:false` (which prevents
 * shell interpretation), this check is defence-in-depth against a crafted config
 * that might specify a dangerous program or exploit a future spawn regression.
 *
 * @param {string} command - The raw command string.
 * @param {string} [code='COGNIS_UNSAFE_COMMAND'] - Error code to attach.
 * @returns {string[]} Tokens, where tokens[0] is the program name.
 */
export function assertSafeCommand(command, code = 'COGNIS_UNSAFE_COMMAND') {
  const tokens = splitCommand(command);
  for (const token of tokens) {
    if (shellControlPattern.test(token)) {
      const error = new Error('Command contains shell metacharacters and cannot be executed safely.');
      error.code = code;
      throw error;
    }
  }
  return tokens;
}
