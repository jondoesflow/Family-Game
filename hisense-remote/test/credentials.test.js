'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { generateCredentials, authMethodForProtocol, normaliseMac } = require('../lib/credentials');

// Vectors computed independently in Python from the published algorithm.
const MAC = 'A8:B1:2C:3D:4E:5F';
const T = 1762252800;

test('modern credentials', () => {
  const c = generateCredentials(MAC, { method: 'modern', timestamp: T });
  assert.equal(c.clientId, 'A8:B1:2C:3D:4E:5F$his$86C029_vidaacommon_001');
  assert.equal(c.username, 'his$6239759786163466600');
  assert.equal(c.password, '426F8582288528F2A555FC7C5D200495');
});

test('middle and legacy credentials', () => {
  const m = generateCredentials(MAC, { method: 'middle', timestamp: T });
  assert.equal(m.username, 'his$6239759786163466600');
  assert.equal(m.password, '1B100F02A0B0B900459BE0C2EC3B2255');
  const l = generateCredentials(MAC, { method: 'legacy', timestamp: T });
  assert.equal(l.username, 'his$1762252800');
  assert.equal(l.password, '1B100F02A0B0B900459BE0C2EC3B2255');
});

test('static credentials and MAC normalisation', () => {
  const s = generateCredentials('a8-b1-2c-3d-4e-5f', { method: 'static' });
  assert.equal(s.clientId, 'A8B12C3D4E5F$vidaa_common');
  assert.equal(s.username, 'hisenseservice');
  assert.equal(normaliseMac('a8b12c3d4e5f'), 'a8:b1:2c:3d:4e:5f');
});

test('auth method from protocol version', () => {
  assert.equal(authMethodForProtocol(null), 'modern');
  assert.equal(authMethodForProtocol(3300), 'modern');
  assert.equal(authMethodForProtocol(3100), 'middle');
  assert.equal(authMethodForProtocol(2500), 'legacy');
});
