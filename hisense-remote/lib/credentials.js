'use strict';
// MQTT credential derivation for Hisense / VIDAA TVs.
//
// The TV's built-in broker (port 36669) expects a client id, username and
// password derived from a MAC-style id plus the current Unix time. The scheme
// was reverse engineered from the official VIDAA app (libmqttcrypt.so) by the
// vidaa-control project (MIT licence) and is reproduced here in plain JS.

const crypto = require('crypto');

const PATTERN = '38D65DC30F45109A369A86FCE866A85B';
const VALUE_SUFFIX_MODERN = 'h!i@s#$v%i^d&a*a'; // transport_protocol >= 3290
const VALUE_SUFFIX_LEGACY = 'h*i&s%e!r^v0i1c9'; // transport_protocol < 3290
const TIME_XOR_CONSTANT = 0x5698_1477_2b03_a968n;

const STATIC_USERNAME = 'hisenseservice';
const STATIC_PASSWORD = 'multimqttservice';

// Order in which methods are tried when the TV refuses a login.
const AUTH_METHODS = ['modern', 'middle', 'legacy', 'static'];

function md5Upper(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex').toUpperCase();
}

function sumDigits(n) {
  return String(Math.abs(n)).split('').reduce((a, d) => a + Number(d), 0);
}

function normaliseMac(mac) {
  let m = String(mac).trim();
  if (!m.includes(':') && !m.includes('-') && m.length === 12) {
    m = m.match(/.{2}/g).join(':');
  }
  return m.replace(/-/g, ':');
}

// Pick the auth method from the transport_protocol value the TV publishes in
// its UPnP descriptor. Unknown => modern (the fallback order tries the rest).
function authMethodForProtocol(version) {
  if (version == null) return 'modern';
  if (version >= 3290) return 'modern';
  if (version >= 3000) return 'middle';
  return 'legacy';
}

function generateCredentials(mac, { method = 'modern', brand = 'his', operation = 'vidaacommon', timestamp } = {}) {
  const uuid = normaliseMac(mac); // case is significant: keep it as given
  const t = timestamp == null ? Math.floor(Date.now() / 1000) : timestamp;

  if (method === 'static') {
    return {
      clientId: `${uuid.replace(/:/g, '').toUpperCase()}$vidaa_common`,
      username: STATIC_USERNAME,
      password: STATIC_PASSWORD,
      method,
    };
  }

  const raceMd5 = md5Upper(`${PATTERN}$${uuid}`).slice(0, 6);
  const clientId = `${uuid}$${brand}$${raceMd5}_${operation}_001`;

  const username = method === 'legacy'
    ? `${brand}$${t}`
    : `${brand}$${(BigInt(t) ^ TIME_XOR_CONSTANT).toString()}`;

  const suffix = method === 'modern' ? VALUE_SUFFIX_MODERN : VALUE_SUFFIX_LEGACY;
  const value = `${brand}${sumDigits(t) % 10}${suffix}`;
  const valueMd5 = md5Upper(value).slice(0, 6);
  const password = md5Upper(`${t}$${valueMd5}`);

  return { clientId, username, password, method };
}

module.exports = { generateCredentials, authMethodForProtocol, normaliseMac, AUTH_METHODS };
