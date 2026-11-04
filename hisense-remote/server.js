#!/usr/bin/env node
'use strict';
// Hisense phone remote: a tiny HTTP server for the home network that serves
// the remote-control web page and relays button presses to the TV over MQTT.
//
//   node server.js --tv 192.168.1.50            (MAC is looked up automatically)
//   node server.js --tv 192.168.1.50 --mac AA:BB:CC:DD:EE:FF --port 8585
//
// Then open http://<this computer's IP>:8585 on your phone.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { HisenseTv } = require('./lib/tv');
const { lookupMac, wake, lanAddresses, discover, describeTv } = require('./lib/net');
const { normaliseMac } = require('./lib/credentials');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

function jsonFile(file) {
  return {
    get() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } },
    set(data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); },
    clear() { try { fs.unlinkSync(file); } catch (e) { /* already gone */ } },
  };
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > limit) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('body must be JSON')); }
    });
    req.on('error', reject);
  });
}

function createApp({ dataDir, host, mac, tvPort, log }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const configStore = jsonFile(path.join(dataDir, 'config.json'));
  const tokenStore = jsonFile(path.join(dataDir, 'tokens.json'));
  const config = Object.assign({ host: null, mac: null, port: 36669 }, configStore.get() || {});
  if (host) config.host = host;
  if (mac) config.mac = normaliseMac(mac);
  if (tvPort) config.port = tvPort;
  configStore.set(config);

  let tv = null;
  const clients = new Set(); // server-sent event streams

  function broadcast() {
    const data = `data: ${JSON.stringify(tv ? tv.snapshot() : { status: 'idle' })}\n\n`;
    for (const res of clients) res.write(data);
  }

  async function startTv() {
    if (tv) tv.close();
    tv = null;
    if (!config.host) return;
    if (!config.mac) {
      const found = await lookupMac(config.host).catch(() => null);
      if (found) { config.mac = found; configStore.set(config); log(`Found TV MAC ${found}`); }
      else log('Could not find the TV MAC address; set it in Settings if pairing fails');
    }
    tv = new HisenseTv({ host: config.host, port: config.port, mac: config.mac, store: tokenStore, log });
    tv.on('update', broadcast);
    tv.connect().catch((e) => log(`connect failed: ${e.message}`));
  }

  const need = () => { if (!tv) throw new Error('Set the TV address first'); if (!tv.connected) throw new Error(`Not connected to the TV (${tv.status})`); return tv; };

  const routes = {
    'GET /api/status': async () => ({ ...(tv ? tv.snapshot() : { status: 'idle' }), config, addresses: lanAddresses() }),
    'GET /api/discover': async () => ({ devices: await discover() }),
    'POST /api/config': async (body) => {
      if (body.host != null) config.host = String(body.host).trim() || null;
      if (body.mac != null) config.mac = body.mac ? normaliseMac(body.mac) : null;
      if (body.port != null) config.port = Number(body.port) || 36669;
      configStore.set(config);
      await startTv();
      return { ok: true, config };
    },
    'POST /api/key': async (body) => ({ ok: need().sendKey(String(body.key || '')) }),
    'POST /api/pin': async (body) => ({ ok: need().sendPin(body.pin) }),
    'POST /api/pair': async () => ({ ok: need().pair() }),
    'POST /api/forget': async () => { if (!tv) throw new Error('Set the TV address first'); await tv.forgetPairing(); return { ok: true }; },
    'POST /api/reconnect': async () => { if (!tv) await startTv(); else await tv.connect(); return { ok: true }; },
    'POST /api/volume': async (body) => ({ ok: need().setVolume(body.level) }),
    'POST /api/source': async (body) => ({ ok: need().setSource(body.sourceid, body.sourcename) }),
    'POST /api/app': async (body) => ({ ok: need().launchApp(body) }),
    'POST /api/sources': async () => ({ ok: need().requestSources() }),
    'POST /api/apps': async () => ({ ok: need().requestApps() }),
    'POST /api/wake': async () => {
      if (!config.mac) throw new Error('Wake-on-LAN needs the TV MAC address (Settings)');
      await wake(config.mac);
      if (tv && !tv.connected) tv.connect().catch(() => {});
      return { ok: true };
    },
    'GET /api/describe': async (_b, url) => ({ info: await describeTv(url.searchParams.get('host') || config.host) }),
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === 'GET /api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify(tv ? tv.snapshot() : { status: 'idle' })}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }
      if (routes[route]) {
        const body = req.method === 'POST' ? await readBody(req) : {};
        const out = await routes[route](body, url);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(out));
      }
      if (url.pathname.startsWith('/api/')) throw Object.assign(new Error('Not found'), { status: 404 });

      // static files
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.join(PUBLIC_DIR, path.normalize(rel));
      if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); return res.end('Not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      res.writeHead(err.status || 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  return {
    server,
    start: (port, bind = '0.0.0.0') => new Promise((resolve) => {
      server.listen(port, bind, async () => { await startTv(); resolve(server.address()); });
    }),
    stop: () => new Promise((resolve) => { if (tv) tv.close(); for (const c of clients) c.end(); server.close(() => resolve()); }),
    get tv() { return tv; },
    config,
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tv' || a === '--host') out.host = argv[++i];
    else if (a === '--mac') out.mac = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--tv-port') out.tvPort = Number(argv[++i]);
    else if (a === '--data') out.dataDir = argv[++i];
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node server.js [--tv <ip>] [--mac <mac>] [--port 8585] [--data <dir>] [--quiet]');
    process.exit(0);
  }
  const port = args.port || Number(process.env.PORT) || 8585;
  const log = args.quiet ? () => {} : (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);
  const app = createApp({
    dataDir: args.dataDir || process.env.HISENSE_DATA_DIR || path.join(__dirname, 'data'),
    host: args.host || process.env.HISENSE_TV_HOST,
    mac: args.mac || process.env.HISENSE_TV_MAC,
    tvPort: args.tvPort,
    log,
  });
  app.start(port).then(() => {
    console.log('\nHisense phone remote is running. Open one of these on your phone:');
    for (const a of lanAddresses()) console.log(`   http://${a.address}:${port}/`);
    if (!app.config.host) console.log('\nNo TV address yet: open the page, tap Settings and pick your TV.');
    console.log('');
  });
  process.on('SIGINT', () => app.stop().then(() => process.exit(0)));
}

module.exports = { createApp };
