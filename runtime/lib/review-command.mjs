const issueId = /^[A-Z][A-Z0-9]{0,15}-[0-9]{1,10}$/u;

// A project-owned CLI cannot attest the host session, process isolation or
// credential boundary. This preflight deliberately does not launch OCR.
export async function reviewReport(args, { resolveEndpoint } = {}) {
  const report = { schemaVersion: 1, command: 'review', subcommand: 'ocr', status: 'blocked' };
  if (args._.length !== 2 || args._[1] !== 'ocr' || args.task.length !== 1
    || !issueId.test(args.task[0]) || typeof args.target !== 'string') {
    return { ...report, code: 'OCR_INVOCATION_INVALID', error: 'Use review ocr --task <ISSUE-ID> --target <https-model-endpoint>.' };
  }
  let requested;
  try { requested = new URL(args.target); } catch { /* rejected below */ }
  if (requested?.protocol !== 'https:' || requested.username || requested.password || requested.hash || requested.search) {
    return { ...report, code: 'OCR_TARGET_INVALID', error: 'A credential-free HTTPS model endpoint is required.' };
  }
  if (!resolveEndpoint) {
    try {
      ({ resolveOcrEndpoint: resolveEndpoint } = await import('../tools/open-code-review/ocr-config.mjs'));
    } catch {
      return { ...report, code: 'OCR_TOOL_UNAVAILABLE', error: 'The optional Open Code Review runtime is not installed.' };
    }
  }
  let endpoint;
  try {
    endpoint = await resolveEndpoint();
  } catch {
    return { ...report, code: 'OCR_CONFIG_READ_FAILED', error: 'Open Code Review endpoint could not be read.' };
  }
  if (endpoint?.status !== 'ready') {
    return { ...report, code: endpoint?.diagnostic?.code ?? 'OCR_CONFIG_MISSING', error: 'Open Code Review endpoint is not ready.' };
  }
  let configured;
  try { configured = new URL(endpoint.env.OCR_LLM_URL); } catch { /* rejected below */ }
  if (!configured || configured.origin !== requested.origin) {
    return { ...report, code: 'OCR_TARGET_MISMATCH', error: 'Requested model endpoint does not match the configured endpoint.' };
  }
  return { ...report, code: 'HOST_BROKER_REQUIRED', error: 'This project-owned CLI cannot issue host proof or launch a credentialed review; use an authenticated host broker or an independent host-native reviewer.' };
}
