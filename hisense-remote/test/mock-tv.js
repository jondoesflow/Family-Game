'use strict';
// A fake Hisense TV: an MQTT broker over TLS that demands the VIDAA client
// certificate, checks the time-derived login (or an issued token), shows a
// "PIN" when asked to pair, and records every key it receives.

const tls = require('tls');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const aedes = require('aedes');
const { generateCredentials } = require('../lib/credentials');

function selfSigned() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-tv-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=MockTV'], { stdio: 'ignore' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function startMockTv({ mac, pin = 1234, method = 'modern', tolerance = 120 } = {}) {
  const broker = aedes();
  const received = { keys: [], publishes: [], logins: [] };
  const tokens = { access: 'ACCESS-TOKEN-1', refresh: 'REFRESH-TOKEN-1' };
  let pinShown = false;

  broker.authenticate = (client, username, password, cb) => {
    const pass = password ? password.toString() : '';
    const peer = client.conn.getPeerCertificate && client.conn.getPeerCertificate();
    const cn = peer && peer.subject && peer.subject.CN;
    received.logins.push({ clientId: client.id, username, password: pass, cn });
    if (cn !== 'VidaaAppAndroidV01') return cb(Object.assign(new Error('bad cert'), { returnCode: 5 }), false);
    if (pass === tokens.access || pass === tokens.refresh) return cb(null, true);
    // Time-derived login: accept any timestamp within the tolerance window.
    const now = Math.floor(Date.now() / 1000);
    for (let t = now - tolerance; t <= now + tolerance; t++) {
      const c = generateCredentials(mac, { method, timestamp: t });
      if (c.clientId === client.id && c.username === username && c.password === pass) return cb(null, true);
    }
    cb(Object.assign(new Error('bad credentials'), { returnCode: 4 }), false);
  };

  const reply = (topic, payload) => broker.publish({ topic, payload: JSON.stringify(payload), qos: 0, retain: false }, () => {});

  broker.on('publish', (packet, client) => {
    if (!client) return;
    const topic = packet.topic;
    const text = packet.payload.toString();
    received.publishes.push({ topic, text });
    const m = topic.match(/^\/remoteapp\/tv\/(\w+)\/(.+)\/actions\/(\w+)$/) || topic.match(/^\/remoteapp\/tv\/(\w+)\/(.+)\/data\/(\w+)$/);
    if (!m) return;
    const [, , clientId, action] = m;
    if (action === 'sendkey') {
      received.keys.push(text);
      reply('/remoteapp/mobile/broadcast/ui_service/state', { statetype: 'livetv' });
    } else if (action === 'vidaa_app_connect') {
      pinShown = true;
      reply('/remoteapp/mobile/broadcast/ui_service/state', { statetype: 'authentication' });
    } else if (action === 'authenticationcode') {
      const body = JSON.parse(text);
      const ok = pinShown && body.authNum === pin;
      reply(`/remoteapp/mobile/${clientId}/ui_service/data/authentication`, { result: ok ? 1 : 0 });
    } else if (action === 'gettoken') {
      reply(`/remoteapp/mobile/${clientId}/platform_service/data/tokenissuance`, {
        accesstoken: tokens.access, refreshtoken: tokens.refresh, accesstoken_duration_day: 7, refreshtoken_duration_day: 30,
      });
    } else if (action === 'getvolume') {
      reply('/remoteapp/mobile/broadcast/ui_service/volume', { volume_type: 0, volume_value: 23 });
    } else if (action === 'gettvstate') {
      reply(`/remoteapp/mobile/${clientId}/ui_service/data/gettvstate`, { statetype: 'livetv' });
    } else if (action === 'sourcelist') {
      reply(`/remoteapp/mobile/${clientId}/ui_service/data/sourcelist`, [{ sourceid: '3', sourcename: 'HDMI1', displayname: 'Sky box' }]);
    }
  });

  const { key, cert } = selfSigned();
  const server = tls.createServer({ key, cert, requestCert: true, rejectUnauthorized: false }, broker.handle);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        received,
        tokens,
        close: () => new Promise((r) => { broker.close(() => server.close(() => r())); }),
      });
    });
  });
}

module.exports = { startMockTv };
