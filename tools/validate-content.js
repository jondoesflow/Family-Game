// Validates the question bank: shape, answer indexes, duplicates, readability limits.
// Runs in CI before every build so a typo in a question can never ship.
const path = require('path');
global.window = {};
require(path.resolve(__dirname, '../web/content-core.js'));
require(path.resolve(__dirname, '../web/content-extra.js'));
require(path.resolve(__dirname, '../web/content-trivia.js'));
require(path.resolve(__dirname, '../web/content-music.js'));
require(path.resolve(__dirname, '../web/content-dingbats.js'));
require(path.resolve(__dirname, '../web/content-xmas.js'));
require(path.resolve(__dirname, '../web/content-eras.js'));
require(path.resolve(__dirname, '../web/content-faces.js'));
const C = window.CONTENT, X = window.CONTENT_EXTRA, T = window.CONTENT_TRIVIA, M = window.CONTENT_MUSIC, D = window.CONTENT_DINGBATS, XM = window.CONTENT_XMAS, E = window.CONTENT_ERAS, F = window.CONTENT_FACES;
const errors = [];
const ids = new Map();
const seenQ = new Map();
function check(item, kind, limits) {
  limits = limits || { q: 18, opt: 6 };
  if (!item.id) errors.push(`${kind}: item without id: ${JSON.stringify(item).slice(0, 80)}`);
  if (ids.has(item.id)) errors.push(`${kind} ${item.id}: duplicate id (also in ${ids.get(item.id)})`);
  ids.set(item.id, kind);
  if (![1, 2, 3, 4].includes(item.level)) errors.push(`${kind} ${item.id}: level must be 1, 2 or 3`);
  if (!item.cat || typeof item.cat !== 'string') errors.push(`${kind} ${item.id}: missing cat`);
  if (typeof item.q !== 'string' || !item.q.trim()) errors.push(`${kind} ${item.id}: missing question text`);
  else {
    const words = item.q.trim().split(/\s+/).length;
    if (words > limits.q) errors.push(`${kind} ${item.id}: question is ${words} words (max ${limits.q})`);
    const key = ((item.prompt || '') + ' ' + item.q).trim().toLowerCase();
    if (seenQ.has(key)) errors.push(`${kind} ${item.id}: duplicate question text (also ${seenQ.get(key)})`);
    seenQ.set(key, item.id);
  }
  if (item.fact && item.fact.split(/\s+/).length > 20) errors.push(`${kind} ${item.id}: fact too long`);
  if (kind === 'tf') {
    if (typeof item.answer !== 'boolean') errors.push(`tf ${item.id}: answer must be true/false`);
  } else {
    if (!Array.isArray(item.options) || item.options.length !== 4) errors.push(`${kind} ${item.id}: needs exactly 4 options`);
    else {
      if (new Set(item.options.map(o => String(o).trim().toLowerCase())).size !== 4) errors.push(`${kind} ${item.id}: options not distinct`);
      item.options.forEach(o => { if (String(o).split(/\s+/).length > limits.opt) errors.push(`${kind} ${item.id}: option too long: "${o}"`); });
    }
    if (!Number.isInteger(item.answer) || item.answer < 0 || item.answer > 3) errors.push(`${kind} ${item.id}: answer index out of range`);
  }
  if (kind === 'emoji' && !(item.prompt && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(item.prompt))) errors.push(`emoji ${item.id}: prompt has no emoji`);
}
(C.quiz || []).forEach(i => check(i, 'quiz'));
(X.quiz || []).forEach(i => check(i, 'quiz'));
(C.emoji || []).forEach(i => check(i, 'emoji'));
(X.flags || []).forEach(i => check(i, 'emoji'));
(X.tf || []).forEach(i => check(i, 'tf'));
const TL = { q: 30, opt: 9 };
(T.quiz || []).forEach(i => check(i, 'quiz', TL));
(T.tf || []).forEach(i => check(i, 'tf', TL));

(XM.quiz || []).forEach(i => check(i, 'quiz'));
(XM.tf || []).forEach(i => check(i, 'tf'));
(E.quiz || []).forEach(i => { check(i, 'quiz', { q: 22, opt: 7 }); if (!(i.era >= 1960 && i.era <= 2020 && i.era % 10 === 0)) errors.push(`eras ${i.id}: bad era`); });
(D.items || []).forEach(d => {
  if (ids.has(d.id)) errors.push(`dingbat ${d.id}: duplicate id`); ids.set(d.id, 'dingbat');
  if (!Array.isArray(d.items) || !d.items.length || !['stack', 'row', 'cross'].includes(d.layout)) errors.push(`dingbat ${d.id}: bad layout`);
  if (!Array.isArray(d.options) || d.options.length !== 4 || new Set(d.options).size !== 4 || d.answer < 0 || d.answer > 3) errors.push(`dingbat ${d.id}: bad options`);
});
const faces = (F && F.faces) || [];
faces.forEach(f => {
  if (!f.id || !f.name || !f.img || !f.credit || !f.credit.licence) errors.push(`face ${f.id}: missing field`);
  if (!require('fs').existsSync(path.resolve(__dirname, '../web', f.img))) errors.push(`face ${f.id}: image file missing ${f.img}`);
  if (/NC|ND/i.test(f.credit.licence)) errors.push(`face ${f.id}: non-free licence ${f.credit.licence}`);
});
console.log(`Dingbats: ${(D.items || []).length} | Christmas: ${(XM.quiz || []).length + (XM.tf || []).length} | Eras: ${(E.quiz || []).length} | Faces: ${faces.length}`);
if (faces.length && faces.length < 60) errors.push('fewer than 60 famous faces; the picture round would repeat too soon');
const tracks = (M && M.tracks) || [];
tracks.forEach(t => {
  if (!t.id || !t.artist || !t.title || !t.preview || !/^https:\/\//.test(t.preview)) errors.push(`music ${t.id}: missing field or preview url`);
  if (!(t.year >= 1950 && t.year <= 2025)) errors.push(`music ${t.id}: odd year ${t.year}`);
  if (![2, 3].includes(t.level)) errors.push(`music ${t.id}: level must be 2 or 3`);
  if (ids.has(t.id)) errors.push(`music ${t.id}: duplicate id`); ids.set(t.id, 'music');
});
const sixtiesNineties = tracks.filter(t => t.decade === 1960 || t.decade === 1990).length;
if (tracks.length && sixtiesNineties / tracks.length < 0.65) errors.push('music bank should be weighted to the 1960s and 1990s');
console.log(`Music: ${tracks.length} tracks (${Math.round(100 * sixtiesNineties / Math.max(1, tracks.length))}% from the 60s and 90s)`);
const all = [...(C.quiz||[]), ...(X.quiz||[]), ...(C.emoji||[]), ...(X.flags||[]), ...(X.tf||[]), ...(T.quiz||[]), ...(T.tf||[]), ...(XM.quiz||[]), ...(XM.tf||[]), ...(E.quiz||[])];
const byLevel = [1, 2, 3, 4].map(l => all.filter(i => i.level === l).length);
const cats = [...new Set(all.map(i => i.cat))];
console.log(`Questions: ${all.length} total  | by level: kid ${byLevel[0]}, family ${byLevel[1]}, grown-up ${byLevel[2]}, expert ${byLevel[3]}`);
console.log(`Types: multiple choice ${(C.quiz||[]).length + (X.quiz||[]).length + (T.quiz||[]).length}, emoji ${(C.emoji||[]).length + (X.flags||[]).length}, true/false ${(X.tf||[]).length + (T.tf||[]).length}`);
console.log(`Categories (${cats.length}): ${cats.join(', ')}`);
[1, 2, 3].forEach(l => { if (byLevel[l - 1] < 60) errors.push(`Only ${byLevel[l - 1]} questions at level ${l}; need at least 60 so games do not repeat quickly`); });
if (errors.length) { console.error('\nCONTENT ERRORS:'); errors.forEach(e => console.error(' - ' + e)); process.exit(1); }
console.log('Content OK');
