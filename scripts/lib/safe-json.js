// JSON parsing helper that strips prototype-pollution vectors.
//
// `JSON.parse` keeps `__proto__` as a regular own enumerable property on the
// returned object. When such an object is later spread (`{ ...config }`) or
// merged via `Object.assign`, the `__proto__` key can propagate and, combined
// with downstream merges, pollute `Object.prototype`. The same applies to the
// `constructor` and `prototype` keys. This helper recursively removes those
// keys from any parsed object/array structure so untrusted project-supplied
// JSON (cognis.config.json, eval suites, transaction journals) cannot reach
// prototype-polluting merge points.

const POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function sanitize(value) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) value[index] = sanitize(value[index]);
    return value;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (POLLUTING_KEYS.has(key)) {
        delete value[key];
      } else {
        value[key] = sanitize(value[key]);
      }
    }
  }
  return value;
}

export function safeJsonParse(text, reviver) {
  const parsed = JSON.parse(text, reviver);
  return sanitize(parsed);
}
