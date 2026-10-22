import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const code = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');

test('publishing rejects content not approved on both entry points', () => {
  assert.match(code, /async function publishItem\(brandId, item\)\s*\{\s*if \(!\['approved', 'scheduled'\]\.includes\(item\.status\)\) return;/);
  assert.match(code, /if \(!\['approved', 'scheduled'\]\.includes\(it\.status\)\) return sendJson\(res, 409/);
});

test('Meta tokens are encrypted with authenticated AES-GCM', () => {
  assert.match(code, /createCipheriv\('aes-256-gcm'/);
  assert.match(code, /createDecipheriv\('aes-256-gcm'/);
  assert.match(code, /cipher\.getAuthTag\(\)/);
  assert.match(code, /decipher\.setAuthTag\(/);
  assert.match(code, /encryptedTokens: encryptMetaTokens\(/);
});

test('Meta API response never includes tokens', () => {
  const start = code.indexOf('const metaPublic =');
  const end = code.indexOf('async function graph(', start);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(code.slice(start, end), /\.tokens|access_token/);
});
