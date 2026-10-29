import test from 'node:test';
import assert from 'node:assert/strict';
import { startupErrorCode } from '../server/startup-error.js';
import { readConfig, resolveMongoUri } from '../server/config.js';

function thrown(callback) {
  try { callback(); } catch (error) { return error; }
  assert.fail('Expected configuration failure');
}

test('startup codes distinguish missing credentials, URI placeholders and invalid API origins', () => {
  assert.equal(startupErrorCode(thrown(() => readConfig({ VERCEL: '1' }))), 'MONGODB_URI_MISSING');
  assert.equal(startupErrorCode(thrown(() => resolveMongoUri({ MONGODB_URI: 'mongodb+srv://<username>:<password>@cluster.invalid/' }))), 'MONGODB_URI_INVALID');
  assert.equal(startupErrorCode(thrown(() => readConfig({ API_ORIGIN: 'http://example.invalid' }))), 'API_ORIGIN_INVALID');
  assert.equal(startupErrorCode(Object.assign(new Error('URI includes private data'), { name: 'MongoParseError' })), 'MONGODB_URI_INVALID');
});

test('wrapped Mongo authentication and permission failures preserve specific startup codes', () => {
  for (const error of [Object.assign(new Error('private details'), { code: 18 }), Object.assign(new Error('bad auth : authentication failed'), { code: 8000 })]) {
    assert.equal(startupErrorCode(new Error('Storage failed', { cause: error })), 'MONGODB_AUTH_FAILED');
  }
  assert.equal(startupErrorCode(new Error('Storage failed', { cause: { code: 13 } })), 'MONGODB_ACCESS_DENIED');
  assert.equal(startupErrorCode({ code: 8000, message: 'A different Atlas error' }), 'STARTUP_FAILED');
});

test('DNS and TLS errors inside server selection topology override generic network classification', () => {
  for (const [code, expected] of [['ENOTFOUND', 'MONGODB_DNS_FAILED'], ['EAI_AGAIN', 'MONGODB_DNS_FAILED'], ['ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR', 'MONGODB_TLS_FAILED'], ['CERT_HAS_EXPIRED', 'MONGODB_TLS_FAILED'], ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'MONGODB_TLS_FAILED']]) {
    const error = Object.assign(new Error('Server selection failed'), {
      name: 'MongoServerSelectionError',
      reason: { servers: new Map([['private-host', { error: new Error('Socket failed', { cause: { code } }) }]]) },
    });
    assert.equal(startupErrorCode(new Error('Storage failed', { cause: error })), expected);
  }
});

test('generic Mongo network failures and unknown exceptions expose only allowlisted codes', () => {
  const secret = 'mongodb+srv://secret-user:secret-password@private-host/';
  for (const name of ['MongoServerSelectionError', 'MongoNetworkError', 'MongoNetworkTimeoutError']) {
    const result = startupErrorCode(Object.assign(new Error(secret), { name }));
    assert.equal(result, 'MONGODB_NETWORK_FAILED');
    assert.ok(!result.includes('secret') && !result.includes('private-host'));
  }
  for (const error of [undefined, null, secret, new Error(secret), { name: secret, message: secret, code: secret }, { code: Symbol(secret) }]) assert.equal(startupErrorCode(error), 'STARTUP_FAILED');
});

test('bounded traversal handles cyclic causes and topology arrays without leaking details', () => {
  const error = new Error('Private details');
  error.cause = error;
  assert.equal(startupErrorCode(error), 'STARTUP_FAILED');
  assert.equal(startupErrorCode({ reason: { servers: [{ error: { code: 'ENODATA' } }] } }), 'MONGODB_DNS_FAILED');
  let chain = { code: 18 };
  for (let index = 0; index < 100; index++) chain = { cause: chain };
  assert.equal(startupErrorCode(chain), 'STARTUP_FAILED');
});
