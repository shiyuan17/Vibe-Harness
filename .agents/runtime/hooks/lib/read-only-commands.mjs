/**
 * Single source of truth for shell segmentation and read-only classification.
 *
 * The policy layer and the Execution Envelope both need to answer "does this
 * shell segment have no side effects?". Keeping two word lists let them drift
 * apart, which produced the misjudged read-only commands recorded as AC-01,
 * AC-02 and AC-04 in audit-reports/2026-09-15-agent-config-review.md. Both
 * consumers import the helpers below instead of keeping private tables.
 */

/**
 * Commands whose presence as the executable token is enough to call the
 * segment read-only. Argument guards below can still withdraw the verdict.
 */
const SIMPLE_READ_ONLY_COMMANDS = new Set([
  // PowerShell cmdlets and aliases.
  'get-childitem', 'get-command', 'get-content', 'get-date', 'get-filehash',
  'get-help', 'get-history', 'get-item', 'get-itemproperty', 'get-location',
  'get-member', 'get-process', 'get-unique', 'convertfrom-json',
  'convertto-json', 'compare-object', 'foreach-object', 'format-custom',
  'format-list', 'format-table', 'format-wide', 'group-object', 'join-string',
  'measure-object', 'out-host', 'out-string', 'resolve-path', 'select-object',
  'select-string', 'sort-object', 'split-path', 'test-path', 'where-object',
  'write-host', 'write-output',
  // Unix and cross-platform read tools.
  'awk', 'basename', 'cat', 'column', 'cut', 'date', 'df', 'dir', 'dirname',
  'du', 'echo', 'env', 'fd', 'file', 'find', 'grep', 'head', 'hostname', 'id', 'jq',
  'ls', 'nl', 'printenv', 'ps', 'pwd', 'readlink', 'realpath', 'rg', 'sed',
  'sort', 'stat', 'tail', 'tr', 'tree', 'type', 'uniq', 'wc', 'which',
  'where', 'whoami',
]);

/**
 * Mutating verbs veto a read-only verdict even when another argument looks
 * like a read verb, for example `terraform state rm` or `aws s3 rm`.
 */
const WRITE_SUBCOMMAND_PATTERN = /^(?:add|apply|attach|authorize|clear|close|commit|copy|create|delete|deploy|destroy|detach|disable|drop|edit|enable|erase|execute|import|install|kill|lock|merge|mkdir|modify|move|mv|patch|post|publish|push|put|rebase|remove|rename|replace|reset|restore|resume|revoke|revert|rm|save|send|set|start|stop|submit|suspend|sync|tag|terminate|truncate|unarchive|unlock|untag|update|upload|write)$/iu;

/** Whole PowerShell verb families that only read or format pipeline data. */
const POWERSHELL_READ_ONLY_VERB_PREFIXES = [
  'compare-', 'convertfrom-', 'foreach-', 'format-', 'get-', 'group-',
  'join-', 'measure-', 'resolve-', 'select-', 'sort-', 'split-', 'test-',
  'where-',
];

/**
 * Arguments that turn an otherwise read-only tool into a writer or an
 * executor. Matching any pattern withdraws the read-only verdict so the
 * request keeps falling through to the Execution Envelope decision.
 */
const READ_ONLY_ARGUMENT_GUARDS = [
  [/(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)(?:\s|$)/iu, /^(?:find|awk|sed)$/iu],
  [/(?:^|\s)--pre(?:=|\s|$)/iu, /^rg$/iu],
  [/(?:^|\s)(?:-i|--in-place)(?:\s|=|$)/iu, /^sed$/iu],
  [/(?:^|\s)(?:system|exec)\s*\(/iu, /^awk$/iu],
  [/(?:^|\s)-{1,2}(?:x|exec|exec-batch)(?:\s|=|$)/iu, /^fd$/iu],
  [/(?:^|\s)-out(?:=|\s|$)/iu, /^terraform$/iu],
];

/**
 * Bare probes that mean "print version or help and exit" for every CLI in the
 * table. They only qualify as the single argument, so `codex exec -v` keeps
 * the effectful verdict of its sub-command.
 */
const READ_ONLY_PROBE_FLAGS = new Set(['-h', '-v', '-V', '--help', '--version']);

/**
 * Read-only sub-command verbs for host and infrastructure CLIs. A verb on its
 * own only qualifies when it is the first argument (for example
 * `kubectl get`); noun forms such as `gh pr view` need the second-level table.
 */
const READ_ONLY_CLI_RULES = new Map([
  ['aws', {
    nouns: { s3: ['head', 'ls'], sts: ['get-caller-identity'] },
    verbPrefix: /^(?:describe|get|list)-/iu,
    verbs: ['head', 'help', 'ls'],
  }],
  ['codegraph', { verbs: ['status'] }],
  ['codex', { nouns: { features: ['list'], mcp: ['get', 'list'] } }],
  ['docker', {
    nouns: {
      compose: ['config', 'logs', 'ls', 'ps'],
      container: ['inspect', 'logs', 'ls'],
      image: ['inspect', 'ls'],
      network: ['inspect', 'ls'],
      volume: ['inspect', 'ls'],
    },
    verbs: ['images', 'info', 'inspect', 'logs', 'ps', 'version'],
  }],
  ['gh', {
    nouns: {
      issue: ['checks', 'diff', 'list', 'status', 'view'],
      pr: ['checks', 'diff', 'list', 'status', 'view'],
      release: ['list', 'view'],
      repo: ['list', 'view'],
      run: ['list', 'view'],
      workflow: ['list', 'view'],
    },
    verbs: ['checks', 'diff', 'list', 'status', 'version', 'view'],
  }],
  ['git', {
    verbs: [
      'blame', 'cat-file', 'check-ignore', 'describe', 'diff', 'for-each-ref',
      'grep', 'log', 'ls-files', 'ls-tree', 'name-rev', 'rev-list',
      'rev-parse', 'shortlog', 'show', 'status', 'symbolic-ref', 'version',
    ],
  }],
  ['glab', {
    nouns: {
      issue: ['diff', 'list', 'view'],
      job: ['list', 'view'],
      mr: ['diff', 'list', 'view'],
      pipeline: ['list', 'view'],
      repo: ['list', 'view'],
    },
    verbs: ['diff', 'list', 'status', 'version', 'view'],
  }],
  ['kubectl', {
    nouns: {
      auth: ['can-i'],
      config: ['current-context', 'get-contexts', 'view'],
      top: ['nodes', 'pods'],
    },
    verbs: [
      'api-resources', 'api-versions', 'describe', 'explain', 'get', 'logs',
      'version',
    ],
  }],
  ['probe', { verbs: ['query', 'search'] }],
  ['terraform', {
    nouns: { state: ['list', 'show'], workspace: ['list', 'show'] },
    verbs: ['output', 'plan', 'providers', 'show', 'validate', 'version'],
  }],
]);

/**
 * Interpreters and toolchain launchers that execute arbitrary code. They stay
 * classified as workspace writes (never as read-only), matching how the Node
 * toolchain was already treated, so the risk grade no longer inverts between
 * "runs a script" and "asks a CLI for its version".
 */
export const RUNTIME_TOOLCHAIN_PATTERN = /(?:^|[\\/])(?:biome|cargo|cmake|deno|dotnet|eslint|go|gradle|gradlew|java|jest|make|mvn|node|npm|npx|perl|php|pnpm|py|pytest|python|python3|rspec|ruby|rustc|tsc|vitest|yarn|bundle)(?:\.exe|\.cmd|\.bat)?$/iu;

const UNSAFE_SHELL_CONSTRUCT_PATTERN = /(?:\$\([^)]*\)|`[^`]*`|\\\r?\n)/u;

/**
 * Shell verbs that change the filesystem. Exported as the single truth source
 * for "is this command write-shaped?": the policy layer's `commandWrites` and
 * the frozen-test write gate both read it, so a new verb cannot be added to one
 * without the other. It deliberately does not treat a bare redirection as a
 * verb — a redirect has a target that callers resolve and judge separately.
 */
export const SHELL_WRITE_VERB_PATTERN = /(?:^|\s)(?:Set-Content|Add-Content|Clear-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|mkdir|md|rmdir|rd|touch|rm|mv|cp|tee|truncate|install|chmod|chown|ln|dd|rsync|del|erase|copy|move|sed\s+-i)(?=\s|$)/iu;

/**
 * Splits a shell command on `&&`, `||`, `;`, `&`, `|` and newlines while
 * honouring quotes, so each segment can be classified on its own.
 *
 * @param {string} command
 * @returns {string[]}
 */
export function shellSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      current += character;
      if (character === quote && command[index - 1] !== '\\') quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (pair === '&&' || pair === '||') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      index += 1;
      continue;
    }
    if (character === ';' || character === '|' || character === '&' || character === '\n' || character === '\r') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

/**
 * Splits a command into tokens, keeping quoted spans together.
 *
 * @param {string} command
 * @returns {string[]}
 */
export function commandTokens(command) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/gu;
  for (const match of command.matchAll(pattern)) tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
}

/** @param {string} command @returns {boolean} */
export function hasUnsafeShellConstruct(command) {
  return UNSAFE_SHELL_CONSTRUCT_PATTERN.test(command);
}

/** @param {string} command @returns {boolean} */
export function hasShellRedirection(command) {
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote && command[index - 1] !== '\\') quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '>' && command[index - 1] !== '<') return true;
  }
  return false;
}

/** `C:\tools\node.exe` becomes `node`, and `LS` becomes `ls`. */
function executableName(token) {
  return token
    .replaceAll('\\', '/')
    .split('/')
    .at(-1)
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat)$/u, '');
}

/** Environment assignments can precede the executable token. */
function isAssignment(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(token) && !token.startsWith('--');
}

/**
 * Splits a segment into its executable token (the first token that is not an
 * environment assignment) and the arguments that follow it, so callers never
 * mistake a quoted argument that happens to name a tool for an invocation.
 *
 * @param {string} segment
 * @returns {{ args: string[], name: string, tokens: string[] } | null}
 */
export function shellInvocation(segment) {
  const tokens = commandTokens(segment);
  let index = 0;
  while (index < tokens.length && isAssignment(tokens[index])) index += 1;
  if (index >= tokens.length) return null;
  return { args: tokens.slice(index + 1), name: executableName(tokens[index]), tokens };
}

function argsMatchGuard(args, name) {
  return READ_ONLY_ARGUMENT_GUARDS.some(([argumentPattern, namePattern]) => (
    namePattern.test(name) && args.some((argument) => argumentPattern.test(argument))
  ));
}

function isReadOnlyCliRule(rule, args) {
  if (args.length === 1 && READ_ONLY_PROBE_FLAGS.has(args[0].toLowerCase())) return true;
  const positional = args.filter((argument) => !argument.startsWith('-'));
  if (positional.length === 0) return false;
  const [first, second] = positional;
  if (WRITE_SUBCOMMAND_PATTERN.test(first)) return false;
  if (second !== undefined && WRITE_SUBCOMMAND_PATTERN.test(second)) return false;
  if (rule.verbPrefix && (rule.verbPrefix.test(first) || (second !== undefined && rule.verbPrefix.test(second)))) return true;
  if (rule.verbs?.includes(first)) return true;
  const nouns = rule.nouns ?? {};
  if (Object.hasOwn(nouns, first)) {
    return second !== undefined && nouns[first].includes(second);
  }
  return false;
}

/**
 * True when the segment is provably free of side effects: a known read-only
 * command (optionally behind a read-only sub-command) with no guard argument.
 *
 * @param {string} segment
 * @returns {boolean}
 */
export function isReadOnlyShellSegment(segment) {
  const invocation = shellInvocation(segment);
  if (!invocation) return false;
  const { args, name } = invocation;
  const rule = READ_ONLY_CLI_RULES.get(name);
  if (rule) return isReadOnlyCliRule(rule, args);
  const known = SIMPLE_READ_ONLY_COMMANDS.has(name)
    || POWERSHELL_READ_ONLY_VERB_PREFIXES.some((prefix) => name.startsWith(prefix));
  if (!known) return false;
  return !argsMatchGuard(args, name);
}

/**
 * True when the segment writes to the filesystem: a write cmdlet, a write
 * utility, or a shell redirection.
 *
 * @param {string} segment
 * @returns {boolean}
 */
export function commandWrites(segment) {
  if (SHELL_WRITE_VERB_PATTERN.test(segment)) return true;
  return hasShellRedirection(segment);
}

/**
 * Exact, argument-free command forms the policy layer already proves free of
 * side effects. Hosts that express tool permissions as glob/pattern maps (the
 * OpenCode role projection) turn these into `allow` entries ahead of the `"*"`
 * fallback so read-only probes stop asking for approval.
 *
 * Only argument-free forms are exported on purpose: a pattern such as
 * `git log*` also matches `git log --output=<file>`, which writes. Derived from
 * the tables above and re-checked through `isReadOnlyShellSegment`, so a
 * classification change here cannot silently widen a host permission map.
 *
 * @returns {string[]}
 */
export function readOnlyCommandPrefixes() {
  const prefixes = new Set();
  for (const name of SIMPLE_READ_ONLY_COMMANDS) {
    if (isReadOnlyShellSegment(name)) prefixes.add(name);
  }
  for (const [name, rule] of READ_ONLY_CLI_RULES) {
    for (const verb of rule.verbs ?? []) {
      const candidate = name + ' ' + verb;
      if (isReadOnlyShellSegment(candidate)) prefixes.add(candidate);
    }
    for (const [noun, verbs] of Object.entries(rule.nouns ?? {})) {
      for (const verb of verbs) {
        const candidate = name + ' ' + noun + ' ' + verb;
        if (isReadOnlyShellSegment(candidate)) prefixes.add(candidate);
      }
    }
  }
  return [...prefixes].sort();
}

/** Tools that ask a host or MCP server to return something without mutating it. */
const READ_ONLY_TOOL_PATTERN = /^(?:read|glob|grep|search|view|inspect|list|status|get|show|fetch|query|websearch|webfetch)$/iu;

/**
 * Local host function tools whose names carry no read verb. They are listed
 * explicitly because the verb table above cannot infer intent from
 * `update_plan` (a host-local checklist, not a workspace file), `view_image`
 * (returns pixels), the sub-agent surfaces, or the thread/automation read
 * tools; an unclassified tool still fails closed with
 * `EXECUTION_ENVELOPE_MISSING`, which would force an Execution Envelope for
 * calls that cannot touch the workspace.
 *
 * Calls that mutate host state stay out of this list on purpose:
 * `write_stdin`, `create_thread`, `fork_thread`, `automation_update`,
 * `handoff_thread`, `set_thread_*`, `send_message_to_thread` and
 * `followup_task` keep the Envelope path, and so does every tool that is not
 * named here.
 */
const READ_ONLY_HOST_TOOL_PATTERN = /^(?:agent|get_goal|get_handoff_status|list_agents|list_archived_threads|list_projects|list_threads|read_file|read_thread|read_thread_terminal|spawn_agent|task|update_plan|view_image|wait_threads)$/iu;

/** Tools that mutate workspace files. */
export const WORKSPACE_TOOL_PATTERN = /(?:^|__|\.)(?:apply_?patch|write(?:_file)?|edit(?:_file)?|delete(?:_file)?|remove(?:_file)?|move(?:_file)?|rename(?:_file)?|create(?:_file|_directory)?|mkdir)(?:$|__)/iu;

/** @param {string} toolName @returns {boolean} */
export function isReadOnlyToolName(toolName) {
  return READ_ONLY_TOOL_PATTERN.test(toolName) || READ_ONLY_HOST_TOOL_PATTERN.test(toolName);
}

/** @param {string} toolName @returns {boolean} */
export function isWorkspaceToolName(toolName) {
  return WORKSPACE_TOOL_PATTERN.test(toolName);
}

/**
 * Explicit, server-scoped MCP tool decisions.
 *
 * The verb table below guesses intent from the words in a tool name, which is
 * all a Hook can do for a server it has never seen. A server whose surface this
 * repository pins does not need guessing: every name in the table is answered
 * from the tool's own contract, so `trace_path` (no read verb) is no longer
 * "unclassified" and `index_repository` (no write verb either) is no longer
 * forced through an Execution Envelope.
 *
 * `read-only` covers tools that cannot change persistent state, plus the
 * reversible graph writes the pinned runtime documents (`index_repository`
 * and `ingest_traces`): they rewrite the tool's own cache, are idempotent, and
 * never touch the project. `workspace-write` mutates project files, and
 * `high-risk` is deliberate data loss.
 *
 * The pinned codebase-memory-mcp surface is listed as its own name/value table
 * so a single source answers both the policy lookup and the documentation.
 *
 * @type {ReadonlyArray<readonly [string, 'read-only' | 'workspace-write' | 'high-risk']>}
 */
const CODEBASE_MEMORY_TOOL_DECISIONS = [
  ['check_index_coverage', 'read-only'],
  ['compare_graphs', 'read-only'],
  ['delete_project', 'high-risk'],
  ['detect_changes', 'read-only'],
  ['get_architecture', 'read-only'],
  ['get_code_snippet', 'read-only'],
  ['get_file_outline', 'read-only'],
  ['get_graph_schema', 'read-only'],
  ['index_repository', 'read-only'],
  ['index_status', 'read-only'],
  ['ingest_traces', 'read-only'],
  ['list_projects', 'read-only'],
  ['manage_adr', 'workspace-write'],
  ['query_graph', 'read-only'],
  ['search_code', 'read-only'],
  ['search_graph', 'read-only'],
  ['trace_path', 'read-only'],
];

/**
 * The codegraph server's core query tools (explore/callers/callees/impact/
 * node/files) carry none of the shared read verbs, so they are registered
 * explicitly instead of relying on verb matching; index-mutating verbs stay
 * out of the table on purpose. Both the `codegraph_`-prefixed live names and
 * the bare short names are covered.
 *
 * @type {ReadonlyArray<readonly [string, 'read-only' | 'workspace-write' | 'high-risk']>}
 */
const CODEGRAPH_TOOL_DECISIONS = [
  ['callers', 'read-only'],
  ['callees', 'read-only'],
  ['codegraph_callers', 'read-only'],
  ['codegraph_callees', 'read-only'],
  ['codegraph_explore', 'read-only'],
  ['codegraph_files', 'read-only'],
  ['codegraph_impact', 'read-only'],
  ['codegraph_node', 'read-only'],
  ['codegraph_search', 'read-only'],
  ['codegraph_status', 'read-only'],
  ['explore', 'read-only'],
  ['files', 'read-only'],
  ['impact', 'read-only'],
  ['node', 'read-only'],
];

/** @type {Map<string, Map<string, 'read-only' | 'workspace-write' | 'high-risk'>>} */
const MCP_TOOL_DECISIONS = new Map([
  ['codebase-memory-mcp', new Map(CODEBASE_MEMORY_TOOL_DECISIONS)],
  ['codegraph', new Map(CODEGRAPH_TOOL_DECISIONS)],
]);

/**
 * Split `mcp__<server>__<tool>` and normalize the server segment so the
 * adapter's `vibe-harness-` prefix and the underscore/hyphen spelling both
 * resolve to the same table entry.
 *
 * @param {string} toolName
 * @returns {{ server: string, tool: string } | null}
 */
function parseMcpToolName(toolName) {
  if (!/^mcp__/iu.test(toolName)) return null;
  const rest = toolName.slice('mcp__'.length);
  const separator = rest.indexOf('__');
  if (separator === -1) return null;
  const server = rest.slice(0, separator).toLowerCase().replaceAll('_', '-').replace(/^vibe-harness-/u, '');
  const tool = rest.slice(separator + 2).toLowerCase();
  if (server === '' || tool === '') return null;
  return { server, tool };
}

/**
 * @param {string} toolName
 * @returns {'read-only' | 'workspace-write' | 'high-risk' | null} `null` when no
 * explicit decision is registered for the server and tool.
 */
export function mcpToolPolicy(toolName) {
  const parsed = parseMcpToolName(toolName);
  if (!parsed) return null;
  return MCP_TOOL_DECISIONS.get(parsed.server)?.get(parsed.tool) ?? null;
}

/**
 * MCP tool names are `<server>__<tool>`; an explicit server contract wins, and
 * anything else is classified by the verbs inside the tool segment instead of
 * requiring one of a few hard-coded read words.
 */
const MCP_READ_VERB_PATTERN = /(?:^|__)(?:checks?|count|describe|diff|exists|export|fetch|find|get|history|inspect|list|logs?|open|query|read|report|search|show|state|status|summary|validate|view)(?:_|__|$)/iu;
const MCP_WRITE_VERB_PATTERN = /(?:^|__)(?:add|apply|archive|assign|cancel|clear|close|commit|create|delete|drop|edit|execute|import|install|lock|mark|merge|move|patch|post|publish|push|put|rebase|remove|rename|reopen|reset|resolve|restore|revert|run|save|send|set|start|stop|submit|subscribe|todo|truncate|unarchive|unassign|unlock|unsubscribe|update|upload|write)(?:_|__|$)/iu;

/**
 * @param {string} toolName
 * @returns {boolean | null} `null` when the tool is not an MCP tool, `true`
 * when it is read-only, and `false` when it mutates or cannot be classified
 * (the caller then requires an Execution Envelope).
 */
export function classifyMcpToolName(toolName) {
  if (!/^mcp__/iu.test(toolName)) return null;
  const policy = mcpToolPolicy(toolName);
  if (policy === 'read-only') return true;
  if (policy !== null) return false;
  if (MCP_WRITE_VERB_PATTERN.test(toolName)) return false;
  if (MCP_READ_VERB_PATTERN.test(toolName)) return true;
  return false;
}
