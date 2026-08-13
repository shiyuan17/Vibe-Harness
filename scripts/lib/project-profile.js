import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { pathExists } from './manifest.js';

const ignoredDirs = new Set([
  '.git',
  '.svn',
  '.hg',
  '.vibe-harness',
  '.agents',
  '.codex',
  'node_modules',
  '.pnpm-store',
  'target',
  'bin',
  'obj',
  'dist',
  'build',
  'coverage',
]);

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function redactSensitiveText(value) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/\b((?:api[-_]?key|password|secret|token)=)[^\s/]+/giu, '$1[REDACTED]')
    .replace(/(--?(?:api[-_]?key|password|secret|token)(?:=|\s+))[^\s]+/giu, '$1[REDACTED]')
    .replace(/\bBearer\s+[^\s]+/giu, 'Bearer [REDACTED]');
}

const loggingContractFields = ['frameworks', 'configFiles', 'sources', 'queries', 'correlationFields', 'verification'];

function emptyLoggingProfile() {
  return {
    status: 'unknown',
    evidence: {
      frameworks: [],
      configFiles: [],
      queryCandidates: [],
      correlationCandidates: [],
    },
    contract: Object.fromEntries(loggingContractFields.map((field) => [field, []])),
  };
}

function normalizedLoggingContract(logging = {}) {
  return Object.fromEntries(loggingContractFields.map((field) => [field, unique(
    Array.isArray(logging[field]) ? logging[field].map(redactSensitiveText).filter(Boolean) : [],
  )]));
}

function loggingStatus(evidence, contract) {
  const hasSources = contract.sources.length > 0;
  const hasQueries = contract.queries.length > 0 || evidence.queryCandidates.length > 0;
  const hasVerification = contract.verification.length > 0;
  if (hasSources && hasQueries && hasVerification) return 'complete';
  if (Object.values(evidence).some((values) => values.length > 0)
    || Object.values(contract).some((values) => values.length > 0)) return 'partial';
  return 'unknown';
}

function withLoggingSummaries(logging) {
  const summarize = (values) => values.length > 0 ? values.join('、') : '未发现';
  return {
    ...logging,
    evidenceSummary: [
      '实现：' + summarize(logging.evidence.frameworks),
      '配置：' + summarize(logging.evidence.configFiles),
      '查询：' + summarize(logging.evidence.queryCandidates),
      '关联字段：' + summarize(logging.evidence.correlationCandidates),
    ].join('；'),
    contractSummary: [
      '实现：' + summarize(logging.contract.frameworks),
      '配置：' + summarize(logging.contract.configFiles),
      '来源：' + summarize(logging.contract.sources),
      '查询：' + summarize(logging.contract.queries),
      '关联字段：' + summarize(logging.contract.correlationFields),
      '验证：' + summarize(logging.contract.verification),
    ].join('；'),
  };
}

function mergeText(base, override) {
  if (typeof override === 'string' && override.trim()) {
    return override.trim();
  }
  return base;
}

async function readJsonIfExists(filePath) {
  if (!(await pathExists(filePath))) {
    return null;
  }
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function readTextIfExists(filePath) {
  if (!(await pathExists(filePath))) {
    return '';
  }
  return readFile(filePath, 'utf8');
}

async function findFiles(targetDir, predicate, { currentDir = targetDir, maxDepth = 3 } = {}) {
  if (maxDepth < 0 || !(await pathExists(currentDir))) {
    return [];
  }

  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) {
        files.push(...await findFiles(targetDir, predicate, { currentDir: fullPath, maxDepth: maxDepth - 1 }));
      }
      continue;
    }
    if (entry.isFile() && predicate(entry.name, fullPath)) {
      files.push(path.relative(targetDir, fullPath).replaceAll('\\', '/'));
    }
  }
  return files.sort();
}

function packageManagerFrom(pkg) {
  if (typeof pkg?.packageManager === 'string') {
    return pkg.packageManager.split('@')[0];
  }
  return 'npm';
}

function commandFromScripts(pkg, names) {
  for (const name of names) {
    if (pkg?.scripts?.[name]) {
      return name;
    }
  }
  return null;
}

function scriptCommand(packageManager, scriptName) {
  if (packageManager === 'npm') {
    return scriptName === 'test' ? 'npm test' : `npm run ${scriptName}`;
  }
  if (packageManager === 'yarn') {
    return `yarn ${scriptName}`;
  }
  return `${packageManager} ${scriptName}`;
}

function detectNodeStack(pkg, hasPnpmWorkspace) {
  if (!pkg) {
    return null;
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const stack = ['Node.js'];
  if (deps.vue) {
    stack.push('Vue 3');
  }
  if (deps.react) {
    stack.push('React');
  }
  if (deps.vite || deps['@vitejs/plugin-vue'] || deps['@vitejs/plugin-react']) {
    stack.push('Vite');
  }
  if (deps.turbo || hasPnpmWorkspace) {
    stack.push('Turbo/monorepo');
  }
  if (deps.vitest) {
    stack.push('Vitest');
  }
  if (deps.playwright) {
    stack.push('Playwright');
  }
  return unique(stack);
}

function detectNodeStandards(pkg) {
  if (!pkg) {
    return [];
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const standards = [];
  if (deps.oxlint || pkg.scripts?.lint?.includes('oxlint')) {
    standards.push('使用 oxlint 进行 JavaScript/TypeScript 静态检查。');
  }
  if (deps.oxfmt || pkg.scripts?.lint?.includes('oxfmt')) {
    standards.push('使用 oxfmt 或现有 format 脚本保持格式。');
  }
  if (deps.eslint || pkg.scripts?.lint?.includes('eslint')) {
    standards.push('遵循现有 ESLint 配置。');
  }
  if (deps.stylelint || pkg.scripts?.lint?.includes('stylelint')) {
    standards.push('样式改动遵循 Stylelint 配置。');
  }
  if (deps.typescript || pkg.scripts?.['check:type'] || pkg.scripts?.typecheck) {
    standards.push('TypeScript 改动必须通过项目 typecheck。');
  }
  return standards;
}

function detectNodeCommands(pkg, packageManager) {
  if (!pkg) {
    return [];
  }
  const commands = [];
  const lintScript = commandFromScripts(pkg, ['lint']);
  const typeScript = commandFromScripts(pkg, ['check:type', 'typecheck', 'ts:check']);
  const testScript = commandFromScripts(pkg, ['test:unit', 'test', 'test:e2e']);
  const governanceScript = commandFromScripts(pkg, ['check:governance']);
  if (lintScript) {
    commands.push(scriptCommand(packageManager, lintScript));
  }
  if (typeScript) {
    commands.push(scriptCommand(packageManager, typeScript));
  }
  if (testScript) {
    commands.push(scriptCommand(packageManager, testScript));
  }
  if (governanceScript) {
    commands.push(scriptCommand(packageManager, governanceScript));
  }
  return commands;
}

function detectNodeLogQueries(pkg, packageManager) {
  if (!pkg?.scripts) return [];
  return Object.keys(pkg.scripts)
    .filter((name) => /^(?:log|logs|tail)(?::|$)|:(?:log|logs|tail)(?::|$)/iu.test(name))
    .map((name) => scriptCommand(packageManager, name));
}

async function detectLoggingProfile({ config, targetDir, pkg, packageManager, pomFiles, csprojFiles }) {
  const contract = normalizedLoggingContract(config.projectRules?.overrides?.logging);
  const dependencies = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const frameworks = [];
  if (dependencies.pino) frameworks.push('Pino');
  if (dependencies.winston) frameworks.push('Winston');

  const pomTexts = await Promise.all(pomFiles.map((file) => readTextIfExists(path.join(targetDir, file))));
  const hasLog4j = pomTexts.some((text) => /spring-boot-starter-log4j2|log4j-(?:core|api|slf4j)/iu.test(text));
  if (pomTexts.some((text) => /spring-boot-starter-logging|logback-(?:classic|core)/iu.test(text)
    || (!hasLog4j && /spring-boot-starter-/iu.test(text)))) frameworks.push('Logback');
  if (hasLog4j) frameworks.push('Log4j');

  const csprojTexts = await Promise.all(csprojFiles.map((file) => readTextIfExists(path.join(targetDir, file))));
  if (csprojTexts.some((text) => /Serilog/iu.test(text))) frameworks.push('Serilog');
  if (csprojTexts.some((text) => /NLog/iu.test(text))) frameworks.push('NLog');

  const knownConfigFiles = await findFiles(targetDir, (name) => {
    const lower = name.toLowerCase();
    return /^(?:pino|winston)\.config\.(?:js|cjs|mjs|ts)$/u.test(lower)
      || /^(?:logback(?:-spring)?\.xml|log4j2\.(?:xml|json|ya?ml|properties)|nlog(?:\.[^.]+)?\.config)$/u.test(lower)
      || /^appsettings(?:\.[^.]+)?\.json$/u.test(lower);
  });
  const configFiles = [];
  for (const file of knownConfigFiles) {
    if (/^appsettings(?:\.[^.]+)?\.json$/iu.test(path.basename(file))) {
      const content = await readTextIfExists(path.join(targetDir, file));
      if (!/(?:Serilog|NLog)/iu.test(content)) continue;
    }
    configFiles.push(file);
  }

  const searchableFiles = (await findFiles(targetDir, (name) => {
    const lower = name.toLowerCase();
    return !['package-lock.json', 'vibe-harness.config.json'].includes(lower)
      && /\.(?:cjs|cs|java|js|json|jsx|mjs|properties|ts|tsx|xml|ya?ml)$/u.test(lower);
  })).slice(0, 250);
  const correlationCandidates = [];
  const searchableContents = await Promise.all(searchableFiles.map((file) => readTextIfExists(path.join(targetDir, file))));
  for (const content of searchableContents) {
    for (const field of ['traceId', 'spanId', 'correlationId', 'requestId']) {
      if (content.includes(field)) correlationCandidates.push(field);
    }
  }

  const evidence = {
    frameworks: unique(frameworks),
    configFiles: unique(configFiles),
    queryCandidates: unique(detectNodeLogQueries(pkg, packageManager)),
    correlationCandidates: unique(correlationCandidates),
  };
  return withLoggingSummaries({ status: loggingStatus(evidence, contract), evidence, contract });
}

function applyOverrides(profile, overrides = {}) {
  if (!overrides || typeof overrides !== 'object') {
    return profile;
  }
  return {
    ...profile,
    codingStandards: mergeText(profile.codingStandards, overrides.codingStandards),
    directoryGuidance: mergeText(profile.directoryGuidance, overrides.directoryGuidance),
    reviewGuidance: mergeText(profile.reviewGuidance, overrides.reviewGuidance),
    stackSummary: mergeText(profile.stackSummary, overrides.stackSummary),
    verificationSummary: mergeText(profile.verificationSummary, overrides.verificationSummary),
    vcsSummary: mergeText(profile.vcsSummary, overrides.vcsSummary),
    vcsStatusCommand: mergeText(profile.vcsStatusCommand, overrides.vcsStatusCommand),
    packageManager: mergeText(profile.packageManager, overrides.packageManager),
    logging: overrides.logging
      ? withLoggingSummaries({
        status: loggingStatus(profile.logging.evidence, normalizedLoggingContract(overrides.logging)),
        evidence: profile.logging.evidence,
        contract: normalizedLoggingContract(overrides.logging),
      })
      : profile.logging,
  };
}

function withVcsStatusInstruction(profile) {
  const command = profile.vcsStatusCommand;
  return {
    ...profile,
    vcsStatusInstruction: command && !command.startsWith('检查')
      ? `编辑前运行 \`${command}\`，保护用户未归属改动。`
      : '编辑前检查目标目录文件状态；当前未配置 VCS 状态命令。',
  };
}

function createGenericProfile(config = {}) {
  return {
    codingStandards: '未发现专用 lint/format 配置；沿用仓库现有代码风格并保持最小改动。',
    directoryGuidance: '未发现显式模块清单；按现有目录职责就近修改。',
    packageManager: config.packageManager ?? 'pnpm',
    reviewGuidance: '按风险与改动范围选择验证方式，并明确未覆盖路径。',
    stackSummary: '未识别到主技术栈；以目标项目现有文件为准。',
    vcsStatusCommand: '检查目标项目 VCS 状态',
    vcsStatusInstruction: '编辑前检查目标目录文件状态；当前未配置 VCS 状态命令。',
    vcsSummary: '未识别 VCS',
    verificationSummary: '使用 vibe-harness.config.json 中的 validationCommands，并补充聚焦测试或人工核对证据。',
    validationCommands: {
      lint: null,
      typecheck: null,
      test: null,
    },
    logging: withLoggingSummaries(emptyLoggingProfile()),
  };
}

export async function detectProjectProfile({ config = {}, targetDir }) {
  const mode = config.projectRules?.mode ?? 'auto';
  if (mode === 'off') {
    return withVcsStatusInstruction(createGenericProfile(config));
  }
  if (mode === 'manual') {
    return withVcsStatusInstruction(applyOverrides(createGenericProfile(config), config.projectRules?.overrides));
  }

  const pkg = await readJsonIfExists(path.join(targetDir, 'package.json'));
  const hasPnpmWorkspace = await pathExists(path.join(targetDir, 'pnpm-workspace.yaml'));
  const pomFiles = await findFiles(targetDir, (name) => name === 'pom.xml');
  const slnFiles = await findFiles(targetDir, (name) => name.endsWith('.sln'));
  const csprojFiles = await findFiles(targetDir, (name) => name.endsWith('.csproj'));
  const editorconfig = await readTextIfExists(path.join(targetDir, '.editorconfig'));
  const hasGit = await pathExists(path.join(targetDir, '.git'));
  const hasSvn = await pathExists(path.join(targetDir, '.svn'));
  const hasPnpmLock = await pathExists(path.join(targetDir, 'pnpm-lock.yaml'));
  const hasNpmLock = await pathExists(path.join(targetDir, 'package-lock.json'));
  const hasYarnLock = await pathExists(path.join(targetDir, 'yarn.lock'));
  const lockPackageManager = hasPnpmLock ? 'pnpm' : (hasYarnLock ? 'yarn' : (hasNpmLock ? 'npm' : null));
  const stackPackageManager = pomFiles.length > 0 ? 'Maven' : (slnFiles.length > 0 || csprojFiles.length > 0 ? 'NuGet/MSBuild' : null);
  const packageManager = pkg?.packageManager ? packageManagerFrom(pkg) : (lockPackageManager ?? stackPackageManager ?? config.packageManager ?? 'pnpm');

  const stacks = [];
  stacks.push(...(detectNodeStack(pkg, hasPnpmWorkspace) ?? []));
  if (pomFiles.length > 0) {
    stacks.push('Java', 'Maven');
    const pomText = await readTextIfExists(path.join(targetDir, pomFiles[0]));
    if (pomText.includes('spring-boot') || pomText.includes('springframework')) {
      stacks.push('Spring');
    }
  }
  if (slnFiles.length > 0 || csprojFiles.length > 0) {
    stacks.push('.NET/MSBuild');
    if (csprojFiles.length > 0) {
      stacks.push('C#');
    }
  }

  const standards = [];
  standards.push(...detectNodeStandards(pkg));
  if (editorconfig.trim()) {
    standards.push('遵循 .editorconfig 中的缩进、换行和字符集约定。');
  }
  if (pomFiles.length > 0) {
    standards.push('Java/Maven 改动遵循现有模块分层和 pom.xml 依赖声明。');
  }
  if (slnFiles.length > 0 || csprojFiles.length > 0) {
    standards.push('.NET 改动遵循现有 solution/project 结构，不手改生成文件。');
  }

  const commands = [
    ...detectNodeCommands(pkg, packageManager),
    ...(pomFiles.length > 0 ? ['mvn test'] : []),
    ...(slnFiles.length > 0 ? [`MSBuild ${slnFiles[0]}`] : []),
  ];

  const directories = unique([
    hasPnpmWorkspace ? 'pnpm workspace packages' : '',
    ...pomFiles.map((file) => path.dirname(file)).filter((dir) => dir !== '.'),
    ...slnFiles,
    ...csprojFiles.slice(0, 5),
  ]);

  const vcsKinds = unique([hasGit ? 'Git' : '', hasSvn ? 'SVN' : '']);
  const vcsStatusCommand = hasGit ? 'git status --short' : (hasSvn ? 'svn status' : '检查目标项目 VCS 状态');
  const detected = {
    codingStandards: standards.length > 0 ? standards.join('\n- ') : '未发现专用 lint/format 配置；沿用仓库现有代码风格并保持最小改动。',
    directoryGuidance: directories.length > 0 ? directories.join(', ') : '未发现显式模块清单；按现有目录职责就近修改。',
    packageManager,
    reviewGuidance: '按 package.json scripts、pom.xml 或 solution 配置选择与改动匹配的验证。',
    stackSummary: unique(stacks).join(', ') || '未识别到主技术栈；以目标项目现有文件为准。',
    vcsStatusCommand,
    vcsSummary: vcsKinds.join(' + ') || '未识别 VCS',
    verificationSummary: unique(commands).join(', ') || '使用 vibe-harness.config.json 中的 validationCommands，并补充聚焦测试或人工核对证据。',
    validationCommands: {
      lint: commands.find((command) => /(?:^|\s)(?:run\s+)?lint(?:\s|$)/u.test(command)) ?? null,
      typecheck: commands.find((command) => /(?:check:type|typecheck|ts:check)/u.test(command)) ?? null,
      test: commands.find((command) => /(?:^|\s)(?:run\s+)?test(?::[^\s]+)?(?:\s|$)|mvn\s+test/u.test(command)) ?? null,
    },
    logging: await detectLoggingProfile({ config, targetDir, pkg, packageManager, pomFiles, csprojFiles }),
  };

  return withVcsStatusInstruction(applyOverrides(detected, config.projectRules?.overrides));
}
