import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const CONFIG_FILE = '.opencodereview/config.json';
const CODEX_CONFIG_FILE = '.codex/config.toml';

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function endpointUrl(url, protocol, useAnthropic) {
  const source = nonEmpty(url);
  if (!source) return undefined;
  const suffix = nonEmpty(protocol)?.toLowerCase() === 'anthropic'
    || nonEmpty(useAnthropic)?.toLowerCase() === 'true'
    ? '/messages'
    : '/chat/completions';
  try {
    const parsed = new URL(source);
    if (!parsed.pathname.endsWith(suffix)) {
      parsed.pathname = parsed.pathname.replace(/\/+$/u, '') + suffix;
    }
    return parsed.toString();
  } catch {
    const normalized = source.replace(/\/+$/u, '');
    return normalized.endsWith(suffix) ? normalized : normalized + suffix;
  }
}

function candidateEnvironment({ authHeader, extraHeaders, model, protocol, timeout, token, url, useAnthropic, baseUrl = false }) {
  const environment = {};
  if (nonEmpty(url)) environment.OCR_LLM_URL = baseUrl ? endpointUrl(url, protocol, useAnthropic) : nonEmpty(url);
  if (nonEmpty(token)) environment.OCR_LLM_TOKEN = nonEmpty(token);
  if (nonEmpty(model)) environment.OCR_LLM_MODEL = nonEmpty(model);
  if (nonEmpty(protocol)) {
    const normalizedProtocol = nonEmpty(protocol).toLowerCase();
    environment.OCR_LLM_PROTOCOL = normalizedProtocol;
    environment.OCR_USE_ANTHROPIC = normalizedProtocol === 'anthropic' ? 'true' : 'false';
  }
  if (nonEmpty(authHeader)) environment.OCR_LLM_AUTH_HEADER = nonEmpty(authHeader);
  if (nonEmpty(extraHeaders)) environment.OCR_LLM_EXTRA_HEADERS = nonEmpty(extraHeaders);
  if (timeout !== undefined && timeout !== null && String(timeout).trim()) environment.OCR_LLM_TIMEOUT = String(timeout).trim();
  if (nonEmpty(useAnthropic)) environment.OCR_USE_ANTHROPIC = nonEmpty(useAnthropic).toLowerCase();
  return environment;
}

function isComplete(environment) {
  return Boolean(environment.OCR_LLM_URL && environment.OCR_LLM_TOKEN && environment.OCR_LLM_MODEL);
}

function isConfigured(environment) {
  return isComplete(environment) || Boolean(environment.OCR_LLM_TOKEN);
}

function pending(diagnostics = []) {
  return {
    diagnostic: diagnostics[0] ?? {
      code: 'OCR_CONFIG_MISSING',
      message: 'Open Code Review configuration is missing or incomplete.',
    },
    status: 'pending-config',
  };
}

async function readOptional(readText, filePath) {
  try {
    return await readText(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function parseUserConfig(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return { error: { code: 'OCR_CONFIG_INVALID', message: 'Open Code Review configuration could not be parsed.' } };
  }
}

async function parseCodexConfig(raw) {
  try {
    const { parse: parseToml } = await import('@iarna/toml');
    return parseToml(raw);
  } catch {
    return { error: { code: 'CODEX_CONFIG_INVALID', message: 'Codex provider configuration could not be parsed.' } };
  }
}

function userProvider(config) {
  const providerName = nonEmpty(config.provider) ?? nonEmpty(config.active_provider) ?? nonEmpty(config.activeProvider);
  if (!providerName) return null;
  return config.custom_providers?.[providerName] ?? config.customProviders?.[providerName] ?? config.providers?.[providerName] ?? null;
}

function preserveCompatibilityVariables(environment, source) {
  for (const name of [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL',
  ]) {
    if (source[name]) environment[name] = source[name];
  }
  return environment;
}

function resolveCompatibilityEnvironment(source) {
  const anthropicToken = nonEmpty(source.ANTHROPIC_AUTH_TOKEN) ?? nonEmpty(source.ANTHROPIC_API_KEY);
  const anthropic = candidateEnvironment({
    baseUrl: true,
    model: source.ANTHROPIC_MODEL,
    token: anthropicToken,
    url: source.ANTHROPIC_BASE_URL,
    useAnthropic: 'true',
  });
  if (isComplete(anthropic)) return preserveCompatibilityVariables(anthropic, source);

  const openai = candidateEnvironment({
    baseUrl: true,
    model: source.OPENAI_MODEL,
    token: source.OPENAI_API_KEY,
    url: source.OPENAI_BASE_URL,
    useAnthropic: 'false',
  });
  if (isConfigured(openai)) return preserveCompatibilityVariables(openai, source);
  return null;
}

function resolveCodexEnvironment(config, source) {
  const providerName = nonEmpty(config.model_provider) ?? nonEmpty(config.provider);
  const provider = providerName ? config.model_providers?.[providerName] : null;
  return candidateEnvironment({
    baseUrl: true,
    model: config.model,
    protocol: provider?.wire_api,
    token: source.OPENAI_API_KEY ?? source.ANTHROPIC_AUTH_TOKEN ?? source.ANTHROPIC_API_KEY,
    url: provider?.base_url,
  });
}

export async function resolveOcrEndpoint({ env = process.env, homeDir, readText = (filePath) => readFile(filePath, 'utf8') } = {}) {
  const explicit = candidateEnvironment({
    authHeader: env.OCR_LLM_AUTH_HEADER,
    extraHeaders: env.OCR_LLM_EXTRA_HEADERS,
    model: env.OCR_LLM_MODEL,
    protocol: env.OCR_LLM_PROTOCOL,
    timeout: env.OCR_LLM_TIMEOUT,
    token: env.OCR_LLM_TOKEN,
    url: env.OCR_LLM_URL,
    useAnthropic: env.OCR_USE_ANTHROPIC,
  });
  if (isComplete(explicit)) return { env: explicit, source: 'explicit', status: 'ready' };

  const resolvedHome = homeDir ?? nonEmpty(env.USERPROFILE) ?? nonEmpty(env.HOME) ?? homedir();
  const diagnostics = [];
  try {
    const raw = await readOptional(readText, path.join(resolvedHome, CONFIG_FILE));
    if (raw !== null) {
      const config = parseUserConfig(raw);
      if (config.error) diagnostics.push(config.error);
      else {
        const provider = userProvider(config);
        const configured = candidateEnvironment({
          baseUrl: true,
          authHeader: provider?.auth_header ?? provider?.authHeader,
          extraHeaders: provider?.extra_headers ?? provider?.extraHeaders,
          model: provider?.model ?? config.model,
          protocol: provider?.protocol,
          timeout: provider?.timeout_sec ?? provider?.timeoutSec,
          token: provider?.api_key ?? provider?.apiKey ?? provider?.token,
          url: provider?.url ?? provider?.base_url ?? provider?.baseUrl,
        });
        if (isComplete(configured)) return { env: configured, source: 'opencodereview', status: 'ready' };
        diagnostics.push({ code: 'OCR_CONFIG_INCOMPLETE', message: 'Open Code Review configuration is incomplete.' });
      }
    }
  } catch {
    diagnostics.push({ code: 'OCR_CONFIG_READ_FAILED', message: 'Open Code Review configuration could not be read.' });
  }

  const compatible = resolveCompatibilityEnvironment(env);
  if (compatible) return { env: compatible, source: 'compat-env', status: 'ready' };

  try {
    const raw = await readOptional(readText, path.join(resolvedHome, CODEX_CONFIG_FILE));
    if (raw !== null) {
      const config = await parseCodexConfig(raw);
      if (config.error) diagnostics.push(config.error);
      else {
        const codex = resolveCodexEnvironment(config, env);
        if (isComplete(codex)) return { env: codex, source: 'codex', status: 'ready' };
        diagnostics.push({ code: 'CODEX_CONFIG_INCOMPLETE', message: 'Codex provider configuration is incomplete.' });
      }
    }
  } catch {
    diagnostics.push({ code: 'CODEX_CONFIG_READ_FAILED', message: 'Codex provider configuration could not be read.' });
  }

  return pending(diagnostics);
}
