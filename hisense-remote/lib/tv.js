'use strict';
// Talks to a Hisense / VIDAA TV over its local MQTT broker (TLS, port 36669).
//
// Flow on a modern TV:
//   1. connect with the bundled client certificate and time-derived credentials
//   2. publish vidaa_app_connect -> the TV shows a 4 digit PIN
//   3. publish the PIN -> TV answers result:1 -> ask for a token
//   4. the TV issues access/refresh tokens; later connections use the access
//      token as the MQTT password and skip the PIN entirely
// Older firmware accepts the login straight away and never asks for a PIN.

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');
const { generateCredentials, authMethodForProtocol, AUTH_METHODS, normaliseMac } = require('./credentials');
const { describeTv } = require('./net');

const topics = {
  sendKey: (c) => `/remoteapp/tv/remote_service/${c}/actions/sendkey`,
  pin: (c) => `/remoteapp/tv/ui_service/${c}/actions/authenticationcode`,
  pinClose: (c) => `/remoteapp/tv/ui_service/${c}/actions/authenticationcodeclose`,
  appConnect: (c) => `/remoteapp/tv/ui_service/${c}/actions/vidaa_app_connect`,
  getToken: (c) => `/remoteapp/tv/platform_service/${c}/data/gettoken`,
  getState: (c) => `/remoteapp/tv/ui_service/${c}/actions/gettvstate`,
  getVolume: (c) => `/remoteapp/tv/platform_service/${c}/actions/getvolume`,
  setVolume: (c) => `/remoteapp/tv/platform_service/${c}/actions/changevolume`,
  sourceList: (c) => `/remoteapp/tv/ui_service/${c}/actions/sourcelist`,
  setSource: (c) => `/remoteapp/tv/ui_service/${c}/actions/changesource`,
  appList: (c) => `/remoteapp/tv/ui_service/${c}/actions/applist`,
  launchApp: (c) => `/remoteapp/tv/ui_service/${c}/actions/launchapp`,
};

const BROADCAST_STATE = '/remoteapp/mobile/broadcast/ui_service/state';
const BROADCAST_VOLUME = '/remoteapp/mobile/broadcast/ui_service/volume';
const BROADCAST_VOLUME2 = '/remoteapp/mobile/broadcast/platform_service/actions/volumechange';

const KEY_RE = /^KEY_[A-Z0-9_]{1,40}$/;
const DAY = 86400 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HisenseTv extends EventEmitter {
  constructor({ host, port = 36669, mac, store, certDir, log = () => {} }) {
    super();
    this.host = host;
    this.port = port;
    this.mac = mac ? normaliseMac(mac) : null;
    this.store = store; // { get(): object|null, set(object), clear() }
    this.log = log;
    this.certDir = certDir || path.join(__dirname, '..', 'certs');
    this.cert = fs.readFileSync(path.join(this.certDir, 'vidaa_client.pem'));
    this.key = fs.readFileSync(path.join(this.certDir, 'vidaa_client.key'));

    this.client = null;
    this.clientId = null;
    this.status = 'idle'; // idle | connecting | connected | unreachable | auth-failed | closed
    this.usingToken = false;
    this.authenticated = false;
    this.pinRequired = false;
    this.method = null;
    this.protocolVersion = null;
    this.tvName = null;
    this.tvState = null;
    this.volume = null;
    this.muted = null;
    this.sources = null;
    this.apps = null;
    this.lastError = null;
    this.lastKey = null;
    this._closed = false;
    this._retry = null;
    this._connecting = false;
  }

  snapshot() {
    return {
      host: this.host, port: this.port, mac: this.mac,
      status: this.status, authenticated: this.authenticated, pinRequired: this.pinRequired,
      usingToken: this.usingToken, method: this.method, protocolVersion: this.protocolVersion,
      tvName: this.tvName, tvState: this.tvState, volume: this.volume, muted: this.muted,
      sources: this.sources, apps: this.apps, lastError: this.lastError, lastKey: this.lastKey,
      paired: Boolean(this._savedToken()),
    };
  }

  _savedToken() {
    const t = this.store && this.store.get();
    if (!t || t.host !== this.host || !t.accessToken) return null;
    return t;
  }

  _emitUpdate() { this.emit('update', this.snapshot()); }

  _setStatus(status, err) {
    this.status = status;
    this.lastError = err ? String(err.message || err) : null;
    this._emitUpdate();
  }

  // ---- connection -------------------------------------------------------

  async connect() {
    if (this._connecting || this._closed) return;
    this._connecting = true;
    clearTimeout(this._retry);
    try {
      await this._connectOnce();
    } finally {
      this._connecting = false;
    }
  }

  _scheduleRetry(ms) {
    if (this._closed) return;
    clearTimeout(this._retry);
    this._retry = setTimeout(() => this.connect().catch(() => {}), ms);
  }

  _candidates() {
    const now = Date.now();
    const saved = this._savedToken();
    const list = [];
    if (saved) {
      if (saved.accessExpires > now + 60000) {
        list.push({ clientId: saved.clientId, username: saved.username, password: saved.accessToken, method: saved.method, token: 'access' });
      }
      if (saved.refreshToken && saved.refreshExpires > now + 60000) {
        list.push({ clientId: saved.clientId, username: saved.username, password: saved.refreshToken, method: saved.method, token: 'refresh', refreshToken: saved.refreshToken });
      }
    }
    if (this.mac) {
      const first = authMethodForProtocol(this.protocolVersion);
      const order = [first, ...AUTH_METHODS.filter((m) => m !== first)];
      for (const method of order) list.push({ ...generateCredentials(this.mac, { method }), token: null });
    }
    return list;
  }

  async _connectOnce() {
    this._teardown();
    this.authenticated = false;
    this.pinRequired = false;
    this.usingToken = false;
    this._setStatus('connecting');

    if (!this.host) return this._setStatus('idle', 'No TV address configured');

    if (this.protocolVersion == null) {
      const info = await describeTv(this.host);
      if (info) {
        this.protocolVersion = info.protocolVersion;
        this.tvName = info.friendlyName || info.modelName || this.tvName;
        this.log(`TV description: ${JSON.stringify(info)}`);
      }
    }

    const candidates = this._candidates();
    if (!candidates.length) return this._setStatus('idle', 'No MAC address configured and no saved pairing');

    for (const creds of candidates) {
      this.log(`Connecting to ${this.host}:${this.port} using ${creds.token ? creds.token + ' token' : creds.method + ' login'}`);
      try {
        await this._attempt(creds);
        this.method = creds.method;
        this.usingToken = Boolean(creds.token);
        this.authenticated = creds.token === 'access';
        this._setStatus('connected');
        this._afterConnect(creds);
        return;
      } catch (err) {
        const code = err && err.code;
        if (code === 4 || code === 5 || code === 2) {
          this.log(`Login refused (${err.message}); trying next method`);
          if (creds.token) {
            // Saved tokens are no longer valid: forget them and pair again.
            this.store.clear();
          }
          await sleep(300);
          continue;
        }
        this.log(`TV unreachable: ${err.message}`);
        this._setStatus('unreachable', err);
        this._scheduleRetry(10000);
        return;
      }
    }
    this._setStatus('auth-failed', 'The TV refused every login method');
    this._scheduleRetry(30000);
  }

  _attempt(creds) {
    return new Promise((resolve, reject) => {
      const client = mqtt.connect({
        protocol: 'mqtts', host: this.host, port: this.port,
        clientId: creds.clientId, username: creds.username, password: creds.password,
        cert: this.cert, key: this.key, rejectUnauthorized: false,
        protocolVersion: 4, clean: true, keepalive: 60,
        connectTimeout: 10000, reconnectPeriod: 0, resubscribe: false,
      });
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        client.removeAllListeners();
        client.on('error', () => {}); // late errors (e.g. connack timeout) after teardown
        client.end(true);
        reject(err || new Error('connection closed'));
      };
      client.once('connect', () => {
        if (settled) return;
        settled = true;
        client.removeAllListeners('error');
        client.removeAllListeners('close');
        this.client = client;
        this.clientId = creds.clientId;
        client.on('message', (t, p) => this._onMessage(t, p));
        client.on('error', (e) => this.log(`MQTT error: ${e.message}`));
        client.on('close', () => this._onClose());
        resolve();
      });
      client.once('error', fail);
      client.once('close', () => fail(new Error('connection closed by TV')));
    });
  }

  _teardown() {
    if (this.client) {
      const c = this.client;
      this.client = null;
      c.removeAllListeners();
      c.on('error', () => {});
      c.end(true);
    }
  }

  _onClose() {
    if (this._closed) return;
    this.client = null;
    this.log('Connection to TV closed');
    this._setStatus('disconnected');
    this._scheduleRetry(5000);
  }

  _afterConnect(creds) {
    const c = this.clientId;
    const subs = [
      BROADCAST_STATE, BROADCAST_VOLUME, BROADCAST_VOLUME2,
      `/remoteapp/mobile/${c}/ui_service/data/authentication`,
      `/remoteapp/mobile/${c}/ui_service/data/authenticationcode`,
      `/remoteapp/mobile/${c}/ui_service/data/vidaa_app_connect`,
      `/remoteapp/mobile/${c}/platform_service/data/tokenissuance`,
      `/remoteapp/mobile/${c}/ui_service/data/sourcelist`,
      `/remoteapp/mobile/${c}/ui_service/data/applist`,
      `/remoteapp/mobile/${c}/platform_service/data/getvolume`,
      `/remoteapp/mobile/${c}/ui_service/data/gettvstate`,
      `/remoteapp/mobile/${c}/#`,
    ];
    this.client.subscribe(subs, { qos: 0 }, () => {});

    if (creds.token === 'refresh') {
      this._publish(topics.getToken(c), { refreshtoken: creds.refreshToken });
    } else if (!creds.token) {
      // Fresh login: ask the TV to pair. Modern firmware shows a PIN, older
      // firmware answers connect_result 1 (already allowed) or stays silent.
      setTimeout(() => this.pair(), 300);
    }
    setTimeout(() => { this.requestState(); this.requestVolume(); }, 800);
  }

  // ---- messages from the TV ---------------------------------------------

  _onMessage(topic, buf) {
    const text = buf.toString();
    // The explicit and wildcard subscriptions can both deliver a message.
    const stamp = `${topic}\n${text}`;
    const now = Date.now();
    if (this._lastMsg === stamp && now - this._lastMsgAt < 300) return;
    this._lastMsg = stamp; this._lastMsgAt = now;
    let payload = text;
    try { payload = JSON.parse(text); } catch (e) { /* plain text */ }
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch (e) { /* leave as string */ }
    }
    this.log(`<- ${topic} ${text.slice(0, 300)}`);
    const obj = payload && typeof payload === 'object' ? payload : {};

    if (topic.endsWith('/data/tokenissuance')) {
      this._onToken(obj);
    } else if (topic.endsWith('/data/authentication') || topic.endsWith('/data/authenticationcode')) {
      if (obj.result === 1 || obj.result === '1') {
        this.authenticated = true;
        this.pinRequired = false;
        this._publish(topics.getToken(this.clientId), { refreshtoken: '' });
        this._publish(topics.pinClose(this.clientId), '');
      } else if (obj.result === 0 || obj.result === '0') {
        this.pinRequired = true;
        this.lastError = 'The TV rejected that PIN';
      } else if (obj.statetype === 'authenticationcode' || obj.statetype === 'authentication') {
        this.pinRequired = true;
      }
    } else if (topic.endsWith('/data/vidaa_app_connect')) {
      if (obj.connect_result === 1 || obj.connect_result === '1') {
        this.authenticated = true;
        this.pinRequired = false;
      }
    } else if (topic === BROADCAST_STATE || topic.endsWith('/data/gettvstate')) {
      this.tvState = obj;
      if (obj.statetype === 'authentication' || obj.statetype === 'authenticationcode') this.pinRequired = true;
      else if (this.pinRequired && obj.statetype && this.authenticated) this.pinRequired = false;
    } else if (topic === BROADCAST_VOLUME || topic === BROADCAST_VOLUME2 || topic.endsWith('/data/getvolume')) {
      const type = obj.volume_type == null ? 0 : Number(obj.volume_type);
      const value = ['volume_value', 'volume', 'value'].map((k) => obj[k]).find((v) => v != null);
      if (type === 0 && value != null) this.volume = Number(value);
      if (type === 2 && value != null) this.muted = Number(value) === 1;
    } else if (topic.endsWith('/data/sourcelist')) {
      this.sources = Array.isArray(payload) ? payload : obj.sourcelist || obj;
    } else if (topic.endsWith('/data/applist')) {
      this.apps = Array.isArray(payload) ? payload : obj.applist || obj;
    }
    this._emitUpdate();
  }

  _onToken(obj) {
    const access = obj.accesstoken;
    if (!access) return;
    const now = Date.now();
    const saved = {
      host: this.host, mac: this.mac, clientId: this.clientId,
      username: this.client && this.client.options.username,
      accessToken: access, refreshToken: obj.refreshtoken || null,
      accessExpires: now + Number(obj.accesstoken_duration_day || 7) * DAY,
      refreshExpires: now + Number(obj.refreshtoken_duration_day || 30) * DAY,
      method: this.method, protocolVersion: this.protocolVersion, savedAt: now,
    };
    this.store.set(saved);
    this.authenticated = true;
    this.pinRequired = false;
    this.usingToken = true;
    this.log('Pairing complete: tokens saved');
  }

  // ---- commands ---------------------------------------------------------

  _publish(topic, payload) {
    if (!this.client || !this.client.connected) return false;
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.log(`-> ${topic} ${body}`);
    this.client.publish(topic, body, { qos: 0 });
    return true;
  }

  get connected() { return Boolean(this.client && this.client.connected); }

  pair() {
    return this._publish(topics.appConnect(this.clientId), { app_version: 2, connect_result: 0, device_type: 'Mobile App' });
  }

  sendPin(pin) {
    const n = Number(String(pin).trim());
    if (!Number.isInteger(n) || n < 0 || n > 999999) throw new Error('PIN must be the digits shown on the TV');
    return this._publish(topics.pin(this.clientId), { authNum: n });
  }

  sendKey(key) {
    if (!KEY_RE.test(key)) throw new Error(`Unknown key ${key}`);
    this.lastKey = key;
    return this._publish(topics.sendKey(this.clientId), key);
  }

  setVolume(level) {
    const n = Number(level);
    if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error('Volume must be 0 to 100');
    return this._publish(topics.setVolume(this.clientId), String(n));
  }

  setSource(sourceid, sourcename) {
    const body = { sourceid: String(sourceid) };
    if (sourcename) body.sourcename = String(sourcename);
    return this._publish(topics.setSource(this.clientId), body);
  }

  launchApp(app) {
    if (!app || !app.name) throw new Error('App needs a name');
    const body = { name: String(app.name), url: String(app.url || app.name) };
    if (app.appId != null) body.appId = String(app.appId);
    return this._publish(topics.launchApp(this.clientId), body);
  }

  requestState() { return this._publish(topics.getState(this.clientId), ''); }
  requestVolume() { return this._publish(topics.getVolume(this.clientId), ''); }
  requestSources() { return this._publish(topics.sourceList(this.clientId), ''); }
  requestApps() { return this._publish(topics.appList(this.clientId), ''); }

  forgetPairing() {
    this.store.clear();
    this.protocolVersion = null;
    return this.connect();
  }

  close() {
    this._closed = true;
    clearTimeout(this._retry);
    this._teardown();
    this._setStatus('closed');
  }
}

module.exports = { HisenseTv, topics, KEY_RE };
