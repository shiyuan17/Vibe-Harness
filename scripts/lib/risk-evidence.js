const HIGH_RISK_PATTERNS = [
  /^\.github\/workflows\//u,
  /^(?:schemas|manifests|adapters|runtime|rules|skills\/core|templates|scripts)\//u,
  /^package\.json$/u,
];

const REQUIRED_SECTIONS = [
  ['impact-scope', /^#{1,6}\s*(?:影响范围|impact scope)\s*$/imu],
  ['relationship-chain', /^#{1,6}\s*(?:关系链|dependency chain|contract chain|test chain|docs? chain)\s*$/imu],
  ['unverified-items', /^#{1,6}\s*(?:未验证项|unverified items?)\s*$/imu],
  ['rollback', /^#{1,6}\s*(?:回滚|rollback)\s*$/imu],
  ['go-no-go', /^#{1,6}\s*(?:go\s*\/\s*no-go|go-no-go|go no-go)\s*$/imu],
];

function sectionContent(body, headingPattern) {
  const headings = [...body.matchAll(/^#{1,6}\s*(.+?)\s*$/gmu)];
  const heading = headings.find((item) => headingPattern.test(item[0]));
  if (!heading) return null;
  const next = headings.find((item) => item.index > heading.index);
  return body.slice(heading.index + heading[0].length, next?.index ?? body.length).trim();
}

function hasFilledContent(content) {
  if (!content) return false;
  return content.split(/\r?\n/u).some((line) => {
    const value = line.replace(/^\s*[-*]\s*/u, '').trim();
    return value.length > 0 && !/^[^:：]+[:：]\s*$/u.test(value);
  });
}

export function classifyChangedPaths(changedPaths) {
  const normalized = changedPaths.map((item) => item.replaceAll('\\', '/'));
  const highRiskPaths = normalized.filter((item) => HIGH_RISK_PATTERNS.some((pattern) => pattern.test(item)));
  return { level: highRiskPaths.length > 0 ? 'high' : 'ordinary', highRiskPaths };
}

export function assessRiskEvidence({ body = '', changedPaths = [] }) {
  const risk = classifyChangedPaths(changedPaths);
  if (risk.level === 'ordinary') return { ...risk, missing: [], ok: true };
  const missing = REQUIRED_SECTIONS
    .filter(([, pattern]) => !hasFilledContent(sectionContent(body, pattern)))
    .map(([id]) => id);
  return { ...risk, missing, ok: missing.length === 0 };
}
