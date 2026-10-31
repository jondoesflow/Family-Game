// Validates the question bank: shape, answer indexes, duplicates, readability limits.
// Runs in CI before every build so a typo in a question can never ship.
const path = require('path');
global.window = {};
require(path.resolve(__dirname, '../web/content.js'));
require(path.resolve(__dirname, '../web/content-extra.js'));
const C = window.CONTENT, X = window.CONTENT_EXTRA;
const errors = [];
const ids = new Map();
const seenQ = new Map();
function check(item, kind) {
  if (!item.id) errors.push(`${kind}: item without id: ${JSON.stringify(item).slice(0, 80)}`);
  if (ids.has(item.id)) errors.push(`${kind} ${item.id}: duplicate id (also in ${ids.get(item.id)})`);
  ids.set(item.id, kind);
  if (![1, 2, 3].includes(item.level)) errors.push(`${kind} ${item.id}: level must be 1, 2 or 3`);
  if (!item.cat || typeof item.cat !== 'string') errors.push(`${kind} ${item.id}: missing cat`);
  if (typeof item.q !== 'string' || !item.q.trim()) errors.push(`${kind} ${item.id}: missing question text`);
  else {
    const words = item.q.trim().split(/\s+/).length;
    if (words > 18) errors.push(`${kind} ${item.id}: question is ${words} words (max 18)`);
    const key = item.q.trim().toLowerCase();
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
      item.options.forEach(o => { if (String(o).split(/\s+/).length > 6) errors.push(`${kind} ${item.id}: option too long: "${o}"`); });
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

const all = [...(C.quiz||[]), ...(X.quiz||[]), ...(C.emoji||[]), ...(X.flags||[]), ...(X.tf||[])];
const byLevel = [1, 2, 3].map(l => all.filter(i => i.level === l).length);
const cats = [...new Set(all.map(i => i.cat))];
console.log(`Questions: ${all.length} total  | by level: kid ${byLevel[0]}, family ${byLevel[1]}, grown-up ${byLevel[2]}`);
console.log(`Types: multiple choice ${(C.quiz||[]).length + (X.quiz||[]).length}, emoji ${(C.emoji||[]).length + (X.flags||[]).length}, true/false ${(X.tf||[]).length}`);
console.log(`Categories (${cats.length}): ${cats.join(', ')}`);
[1, 2, 3].forEach(l => { if (byLevel[l - 1] < 60) errors.push(`Only ${byLevel[l - 1]} questions at level ${l}; need at least 60 so games do not repeat quickly`); });
if (errors.length) { console.error('\nCONTENT ERRORS:'); errors.forEach(e => console.error(' - ' + e)); process.exit(1); }
console.log('Content OK');
