import assert from 'node:assert/strict';
import test from 'node:test';

import { safeJsonParse } from '../scripts/lib/safe-json.js';

test('safeJsonParse strips __proto__ keys from parsed objects', () => {
  const parsed = safeJsonParse('{"__proto__":{"polluted":true},"name":"ok"}');
  assert.equal(parsed.name, 'ok');
  assert.equal(Object.hasOwn(parsed, '__proto__'), false);
  assert.equal(({}).polluted, undefined);
});

test('safeJsonParse strips constructor and prototype keys recursively', () => {
  const parsed = safeJsonParse('{"constructor":{"prototype":{"polluted":true}},"nested":{"prototype":{"x":1},"keep":2},"list":[{"__proto__":{"y":2},"ok":true}]}');
  assert.equal(Object.hasOwn(parsed, 'constructor'), false);
  assert.equal(Object.hasOwn(parsed.nested, 'prototype'), false);
  assert.equal(parsed.nested.keep, 2);
  assert.equal(parsed.list[0].ok, true);
  assert.equal(Object.hasOwn(parsed.list[0], '__proto__'), false);
  assert.equal(({}).polluted, undefined);
  assert.equal(({}).y, undefined);
});

test('safeJsonParse preserves normal nested structures', () => {
  const parsed = safeJsonParse('{"a":[1,2,{"b":3}],"c":{"d":"e"}}');
  assert.deepEqual(parsed, { a: [1, 2, { b: 3 }], c: { d: 'e' } });
});

test('safeJsonParse handles arrays at the top level', () => {
  const parsed = safeJsonParse('[{"__proto__":{"z":9},"ok":true}]');
  assert.equal(parsed[0].ok, true);
  assert.equal(Object.hasOwn(parsed[0], '__proto__'), false);
  assert.equal(({}).z, undefined);
});
