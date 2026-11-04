'use strict';
// Small network helpers: UPnP protocol detection, SSDP discovery, ARP lookup
// of the TV's MAC address, Wake-on-LAN and the bridge's own LAN addresses.

const http = require('http');
const dgram = require('dgram');
const net = require('net');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

const UPNP_PORT = 38400;
const MQTT_PORT = 36669;

function httpGet(url, timeout) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 200000) body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'));
  return m ? m[1].trim() : null;
}

// Reads the TV's UPnP description. Newer VIDAA firmware includes a
// transport_protocol value that tells us which login scheme to use.
async function describeTv(host, { port = UPNP_PORT, timeout = 4000 } = {}) {
  try {
    const xml = await httpGet(`http://${host}:${port}/MediaServer/rendererdevicedesc.xml`, timeout);
    const m = xml.match(/transport_protocol[=:]\s*(\d+)/i);
    return {
      protocolVersion: m ? Number(m[1]) : null,
      friendlyName: tag(xml, 'friendlyName'),
      modelName: tag(xml, 'modelName'),
      manufacturer: tag(xml, 'manufacturer'),
    };
  } catch (e) {
    return null;
  }
}

// Opens and drops a TCP connection so the OS learns the TV's MAC address.
function poke(host, port = MQTT_PORT, timeout = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = () => { s.destroy(); resolve(); };
    s.setTimeout(timeout, done);
    s.on('connect', done);
    s.on('error', done);
  });
}

const MAC_RE = /(?:[0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2}/i;

function tidyMac(raw) {
  const parts = raw.split(/[:-]/).map((p) => p.padStart(2, '0').toUpperCase());
  const mac = parts.join(':');
  if (mac === '00:00:00:00:00:00' || mac === 'FF:FF:FF:FF:FF:FF') return null;
  return mac;
}

function arpCommand(ip) {
  return new Promise((resolve) => {
    const args = process.platform === 'win32' ? ['-a', ip] : ['-n', ip];
    execFile('arp', args, { timeout: 4000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const line = stdout.split('\n').find((l) => l.includes(ip) && MAC_RE.test(l));
      const m = line && line.match(MAC_RE);
      resolve(m ? tidyMac(m[0]) : null);
    });
  });
}

// Finds the MAC address for an IP on the local network.
async function lookupMac(ip) {
  await poke(ip);
  if (process.platform === 'linux') {
    try {
      const table = fs.readFileSync('/proc/net/arp', 'utf8');
      const line = table.split('\n').find((l) => l.split(/\s+/)[0] === ip);
      const m = line && line.match(MAC_RE);
      if (m) {
        const mac = tidyMac(m[0]);
        if (mac) return mac;
      }
    } catch (e) { /* fall through to the arp command */ }
  }
  return arpCommand(ip);
}

// Sends a Wake-on-LAN magic packet. The TV must have "Wake on LAN" (or
// "Wake on Wireless Network") switched on in its network settings.
function wake(mac, { broadcast = '255.255.255.255', port = 9 } = {}) {
  return new Promise((resolve, reject) => {
    const hex = String(mac).replace(/[^0-9a-f]/gi, '');
    if (hex.length !== 12) return reject(new Error('MAC address must be 6 bytes'));
    const macBuf = Buffer.from(hex, 'hex');
    const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(macBuf)]);
    const sock = dgram.createSocket('udp4');
    sock.once('error', (e) => { sock.close(); reject(e); });
    sock.bind(() => {
      sock.setBroadcast(true);
      sock.send(packet, 0, packet.length, port, broadcast, (err) => {
        sock.close();
        err ? reject(err) : resolve();
      });
    });
  });
}

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

// SSDP M-SEARCH for media renderers; VIDAA TVs answer with a LOCATION on
// port 38400. Each candidate is then described so the UI can show its name.
function discover({ timeout = 3000 } = {}) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Map();
    const msg = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\n' +
      'ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n');
    sock.on('message', (buf, rinfo) => {
      const text = buf.toString();
      const loc = (text.match(/^LOCATION:\s*(.+)$/im) || [])[1];
      const server = (text.match(/^SERVER:\s*(.+)$/im) || [])[1] || '';
      const likely = /:38400\//.test(loc || '') || /hisense|vidaa/i.test(text);
      if (!found.has(rinfo.address)) found.set(rinfo.address, { ip: rinfo.address, location: loc, server: server.trim(), likely });
    });
    sock.on('error', () => finish());
    let finished = false;
    const finish = async () => {
      if (finished) return;
      finished = true;
      try { sock.close(); } catch (e) { /* ignore */ }
      const list = [...found.values()];
      await Promise.all(list.map(async (d) => {
        const info = await describeTv(d.ip, { timeout: 2500 });
        if (info) Object.assign(d, info, { likely: true });
      }));
      list.sort((a, b) => Number(b.likely) - Number(a.likely));
      resolve(list);
    };
    sock.bind(() => {
      try {
        sock.setBroadcast(true);
        sock.setMulticastTTL(2);
        sock.send(msg, 0, msg.length, 1900, '239.255.255.250');
        sock.send(msg, 0, msg.length, 1900, '255.255.255.255');
      } catch (e) { /* best effort */ }
      setTimeout(finish, timeout);
    });
  });
}

module.exports = { describeTv, lookupMac, wake, lanAddresses, discover, UPNP_PORT, MQTT_PORT };
