'use strict';
// End-to-end: bridge server <-> fake TV. Pairs with a PIN, sends keys, then
// restarts the bridge and checks it reconnects with the saved token.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMockTv } = require('./mock-tv');
const { createApp } = require('../server');

const MAC = '10:20:30:AA:BB:CC';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 8000, every = 100 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  throw new Error('timed out waiting');
}

async function startBridge(dataDir, tvPort) {
  const app = createApp({ dataDir, host: '127.0.0.1', mac: MAC, tvPort, log: () => {} });
  const addr = await app.start(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  const get = async (p) => (await fetch(base + p)).json();
  const post = async (p, body = {}) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { app, base, get, post };
}

test('pair with PIN, send keys, reconnect with saved token', async () => {
  const tv = await startMockTv({ mac: MAC, pin: 1234 });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
  let b = await startBridge(dataDir, tv.port);
  try {
    // Fresh login lands in the "PIN required" state.
    let s = await waitFor(async () => { const x = await b.get('/api/status'); return x.status === 'connected' && x.pinRequired ? x : null; });
    assert.equal(s.method, 'modern');
    assert.equal(s.authenticated, false);
    assert.ok(tv.received.logins[0].cn === 'VidaaAppAndroidV01', 'client certificate presented');

    // Keys are rejected by the API if malformed.
    const bad = await b.post('/api/key', { key: 'rm -rf' });
    assert.equal(bad.status, 400);

    // Wrong PIN, then the right one.
    await b.post('/api/pin', { pin: '0000' });
    await sleep(300);
    s = await b.get('/api/status');
    assert.equal(s.authenticated, false);
    await b.post('/api/pin', { pin: '1234' });
    s = await waitFor(async () => { const x = await b.get('/api/status'); return x.authenticated && x.paired ? x : null; });
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'tokens.json'), 'utf8'));
    assert.equal(saved.accessToken, tv.tokens.access);
    assert.ok(tv.received.publishes.some((p) => p.topic.endsWith('/actions/authenticationcodeclose')), 'PIN dialog closed');

    // Keys reach the TV; volume broadcast is picked up.
    await b.post('/api/key', { key: 'KEY_VOLUMEUP' });
    await b.post('/api/key', { key: 'KEY_OK' });
    await waitFor(async () => tv.received.keys.length >= 2);
    assert.deepEqual(tv.received.keys, ['KEY_VOLUMEUP', 'KEY_OK']);
    s = await waitFor(async () => { const x = await b.get('/api/status'); return x.volume === 23 ? x : null; });

    // Source list request and app launch.
    await b.post('/api/sources');
    s = await waitFor(async () => { const x = await b.get('/api/status'); return Array.isArray(x.sources) && x.sources.length ? x : null; });
    assert.equal(s.sources[0].displayname, 'Sky box');
    await b.post('/api/app', { appId: '1', name: 'Netflix', url: 'netflix' });
    await waitFor(async () => tv.received.publishes.some((p) => p.topic.endsWith('/actions/launchapp') && p.text.includes('Netflix')));

    // Restart the bridge: it must log in with the access token and skip the PIN.
    await b.app.stop();
    const loginsBefore = tv.received.logins.length;
    b = await startBridge(dataDir, tv.port);
    s = await waitFor(async () => { const x = await b.get('/api/status'); return x.status === 'connected' && x.authenticated ? x : null; });
    assert.equal(s.usingToken, true);
    assert.equal(s.pinRequired, false);
    assert.equal(tv.received.logins[loginsBefore].password, tv.tokens.access);
    await b.post('/api/key', { key: 'KEY_HOME' });
    await waitFor(async () => tv.received.keys.includes('KEY_HOME'));
  } finally {
    await b.app.stop();
    await tv.close();
  }
});

test('TV that is off reports unreachable and keeps retrying', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
  const b = await startBridge(dataDir, 1); // nothing listens on port 1
  try {
    const s = await waitFor(async () => { const x = await b.get('/api/status'); return x.status === 'unreachable' ? x : null; });
    assert.ok(s.lastError);
    const r = await b.post('/api/key', { key: 'KEY_POWER' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Not connected/);
  } finally {
    await b.app.stop();
  }
});
