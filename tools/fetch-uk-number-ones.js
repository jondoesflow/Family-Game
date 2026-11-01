// Pulls every UK Singles Chart number one (1952 to now) from Wikipedia's decade lists and
// writes tools/music-list-uk.json as [artist, title, year, weeks]. Run: node tools/fetch-uk-number-ones.js
const fs = require('fs'); const path = require('path'); const cheerio = require('cheerio');
const UA = { 'User-Agent': 'ZingQuiz/1.0 (family quiz app; contact via github.com/jondoesflow/Family-Game)' };
const decades = ['1950s', '1960s', '1970s', '1980s', '1990s', '2000s', '2010s', '2020s'];
const clean = s => s.replace(/\[[^\]]*\]/g, '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();

// Expand a table into a grid, honouring rowspan/colspan.
function gridOf($, table) {
  const grid = [];
  $(table).find('tr').each((r, tr) => {
    grid[r] = grid[r] || [];
    let c = 0;
    $(tr).children('th,td').each((_, cell) => {
      while (grid[r][c] !== undefined) c++;
      const rs = parseInt($(cell).attr('rowspan') || '1', 10), cs = parseInt($(cell).attr('colspan') || '1', 10);
      const text = clean($(cell).text());
      for (let i = 0; i < rs; i++) for (let j = 0; j < cs; j++) { grid[r + i] = grid[r + i] || []; grid[r + i][c + j] = text; }
      c += cs;
    });
  });
  return grid;
}

(async () => {
  const out = []; const seen = new Set();
  for (const d of decades) {
    const title = `List of UK Singles Chart number ones of the ${d}`;
    const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=text&redirects=1&format=json&formatversion=2`;
    const j = await (await fetch(url, { headers: UA })).json();
    const $ = cheerio.load(j.parse.text);
    let count = 0;
    $('table.wikitable').each((_, table) => {
      const g = gridOf($, table);
      const header = (g[0] || []).map(h => h.toLowerCase());
      const ai = header.findIndex(h => /artist/.test(h)), si = header.findIndex(h => /single|song|title/.test(h));
      const di = header.findIndex(h => /reached|date|week ending/.test(h)), wi = header.findIndex(h => /weeks/.test(h));
      if (ai < 0 || si < 0 || di < 0) return;
      for (let r = 1; r < g.length; r++) {
        const row = g[r]; if (!row || !row[ai] || !row[si]) continue;
        const artist = row[ai], single = row[si];
        const ym = /\b(19[5-9]\d|20[0-2]\d)\b/.exec(row[di] || ''); if (!ym) continue;
        if (/^re-?entry|^re-?release/i.test(single) || /chart|notes|see also/i.test(artist)) continue;
        const weeks = parseInt((row[wi] || '1').replace(/\D/g, ''), 10) || 1;
        const key = (artist + '|' + single).toLowerCase();
        if (seen.has(key)) continue; seen.add(key);
        out.push([artist, single, parseInt(ym[1], 10), weeks]);
        count++;
      }
    });
    console.log(d, count);
    await new Promise(r => setTimeout(r, 1500));
  }
  fs.writeFileSync(path.resolve(__dirname, 'music-list-uk.json'), JSON.stringify(out));
  const byDecade = {}; out.forEach(x => { const k = Math.floor(x[2] / 10) * 10; byDecade[k] = (byDecade[k] || 0) + 1; });
  console.log('total', out.length, byDecade);
})();
