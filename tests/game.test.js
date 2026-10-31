// End-to-end test of the game in a real browser: question selection, Classic mode, turn-by-turn
// (shared) mode with teams, settings persistence and phone-width layout. Uses Playwright + Chromium.
const { chromium } = require('playwright');
const path = require('path');
const assert = require('assert');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('file://' + path.resolve(__dirname, '../web/index.html'));
  await page.waitForSelector('.logo');

  // Pool sanity
  const poolInfo = await page.evaluate(() => ({ n: window.ZING.pool.length, types: [...new Set(window.ZING.pool.map(q => q.type))].sort() }));
  assert(poolInfo.n > 3000, 'pool should have >3000 questions, got ' + poolInfo.n);
  ['dingbat', 'emoji', 'mc', 'music', 'tf'].forEach(t => assert(poolInfo.types.includes(t), 'pool is missing type ' + t + ': ' + poolInfo.types));

  // Age bands: a kid never gets Grown-up or Expert; a grown-up never gets Kid
  const kidLevels = await page.evaluate(() => { const c = { 1: 0, 2: 0, 3: 0, 4: 0 }; for (let i = 0; i < 400; i++) c[window.ZING.pick({ band: 'kid' }, {}, null).level]++; return c; });
  assert.strictEqual(kidLevels[3] + kidLevels[4], 0, 'kid got hard questions: ' + JSON.stringify(kidLevels));
  assert(kidLevels[1] > kidLevels[2], 'kid should mostly get level 1');
  const adultLevels = await page.evaluate(() => { const c = { 1: 0, 2: 0, 3: 0, 4: 0 }; for (let i = 0; i < 400; i++) c[window.ZING.pick({ band: 'adult' }, {}, null).level]++; return c; });
  assert.strictEqual(adultLevels[1], 0, 'adult got kid questions: ' + JSON.stringify(adultLevels));
  assert(adultLevels[3] + adultLevels[4] > adultLevels[2], 'adult should mostly get grown-up/expert: ' + JSON.stringify(adultLevels));

  // No repeats within a game
  const repeats = await page.evaluate(() => { const used = {}; let dup = 0; for (let i = 0; i < 300; i++) { const q = window.ZING.pick({ band: 'adult' }, used, null); if (used[q.id]) dup++; used[q.id] = true; } return dup; });
  assert.strictEqual(repeats, 0, 'questions repeated within a game');

  async function addPlayer(name, band) {
    await page.click('text=Add a player');
    await page.fill('#player-name', name);
    await page.click(`[data-band="${band}"]`);
    await page.click('text=Add player');
  }

  /* ---------- Turn by turn (shared) with teams, 3 players: two adults share a question ---------- */
  await page.click('text=Play on this phone');
  await addPlayer('Nana', 'adult');
  await addPlayer('Ellie', 'kid');
  await addPlayer('Dad', 'adult');
  assert.strictEqual(await page.locator('.player-row').count(), 3);
  await page.click('.switch[aria-label="Play in teams"]');
  assert.strictEqual(await page.locator('.team-badge').count(), 3, 'team badges should appear');
  await page.click('text=Next');
  await page.click('text=Turn by turn');
  await page.click('text=Quick');
  await page.click('text=Start game');

  for (let round = 1; round <= 5; round++) {
    const seenQ = {};
    for (let turn = 0; turn < 3; turn++) {
      await page.waitForSelector('.pass-hero');
      const name = (await page.textContent('.pass-hero .name')).trim();
      await page.click('.btn.primary');
      await page.waitForSelector('.answers .ans');
      seenQ[name] = (await page.evaluate(() => (document.querySelector('.q-prompt') || {}).textContent || '')) + '|' + await page.textContent('.q-text');
      await page.click('.answers .ans >> nth=0');
      await page.waitForSelector('.result');
      assert.strictEqual(await page.locator('.ans.correct').count(), 0, 'turn by turn must not reveal the answer early');
      await page.click('.result .btn.primary');
    }
    assert.strictEqual(seenQ['Nana'], seenQ['Dad'], 'the two grown-ups should get the same question in a round');
    assert.notStrictEqual(seenQ['Ellie'], seenQ['Nana'], 'the kid should get a different (kid) question');
    await page.waitForSelector('.reveal-answer');
    assert(await page.locator('.who-chip').count() >= 3, 'reveal should list every player');
    assert(await page.locator('.bar-row').count() >= 2, 'team scoreboard should show the teams');
    await page.click('.btn.primary');
  }
  await page.waitForSelector('.winner-line');
  const winner = await page.textContent('.winner-line');
  assert(/team wins|tie/.test(winner), 'final screen should name a winning team: ' + winner);

  /* ---------- Classic mode, no teams ---------- */
  await page.click('text=Home');
  await page.click('text=Play on this phone');
  await page.click('.switch[aria-label="Play in teams"]');   // off
  await page.click('text=Next');
  await page.click('text=Classic');
  await page.click('text=Start game');
  const seenTypes = new Set();
  for (let round = 0; round < 5; round++) {
    for (let turn = 0; turn < 3; turn++) {
      await page.waitForSelector('.pass-hero');
      await page.click('.btn.primary');
      await page.waitForSelector('.answers .ans');
      seenTypes.add((await page.textContent('.q-meta .cat:last-child')).split('·')[0].trim());
      await page.click('.answers .ans >> nth=0');
      await page.waitForSelector('.result');
      assert.strictEqual(await page.locator('.ans.correct').count(), 1, 'classic should highlight the correct answer');
      await page.click('.result .btn.primary');
    }
    if (round < 4) { await page.waitForSelector('.board'); await page.click('text=Keep going'); }
  }
  await page.waitForSelector('.podium');
  assert(seenTypes.size >= 2, 'expected at least two question types in a game, saw ' + [...seenTypes]);
  console.log('Classic types seen:', [...seenTypes].join(', '));

  /* ---------- Music questions: three forms, sensible options ---------- */
  const music = await page.evaluate(() => {
    const tracks = window.ZING.pool.filter(q => q.type === 'music');
    const forms = {}; let bad = 0;
    for (let i = 0; i < 300; i++) {
      const t = tracks[i % tracks.length]; const q = window.ZING.prepare(t);
      forms[q.form] = (forms[q.form] || 0) + 1;
      if (q.options.length !== 4 || q.answer < 0 || q.answer > 3 || new Set(q.options).size !== 4 || !q.preview) bad++;
      if (q.form === 'year' && (q.options[q.answer] !== String(t.year) || q.options.map(Number).some((y, k, a) => k && y <= a[k - 1]))) bad++;
      if (q.form === 'title' && q.options[q.answer] !== t.title) bad++;
      if (q.form === 'artist' && q.options[q.answer] !== t.artist) bad++;
    }
    return { n: tracks.length, forms, bad, sixtiesNineties: tracks.filter(t => t.decade === 1960 || t.decade === 1990).length };
  });
  assert(music.n >= 100, 'expected at least 100 music tracks, got ' + music.n);
  assert.strictEqual(music.bad, 0, 'bad music questions generated');
  assert(music.forms.title && music.forms.artist && music.forms.year, 'all three music forms should occur: ' + JSON.stringify(music.forms));
  assert(music.sixtiesNineties / music.n > 0.65, 'music should be weighted to the 60s and 90s');
  console.log('Music:', music.n, 'tracks, forms', JSON.stringify(music.forms));

  /* ---------- Fastest finger first (linked-phone scoring), simulated on one page ---------- */
  await page.click('text=Home');
  await page.click('text=Play on this phone');
  await page.click('text=Next');
  await page.click('text=Turn by turn');
  await page.click('text=Start game');
  await page.evaluate(() => { window.ZING.transport.mode = 'mp'; });
  // Answer every option for every player; collect which were right from the reveal
  for (let turn = 0; turn < 3; turn++) {
    await page.waitForSelector('.pass-hero');
    await page.click('.btn.primary');
    await page.waitForSelector('.answers .ans');
    const answerIdx = await page.evaluate(() => { const st = window.ZING.client.state; const p = window.ZING.client.state.queue.length; return 0; });
    // pick the correct answer for the first two players, wrong for the third, using the engine's round data
    const correct = await page.evaluate((turn) => {
      const st = window.ZING.client.state; const name = document.querySelector('.q-head .chip').textContent.trim();
      const p = st.players.find(x => name.endsWith(x.name)); const q = st.round.byLevel[st.round.byBand[p.band]];
      return turn < 2 ? q.answer : (q.answer + 1) % q.options.length;
    }, turn);
    await page.click(`.answers .ans >> nth=${correct}`);
    await page.waitForSelector('.result');
    await page.click('.result .btn.primary');
  }
  await page.waitForSelector('.reveal-answer');
  const chips = await page.$$eval('.who-chip', els => els.map(e => e.textContent.trim()));
  assert(chips.some(c => /⚡ 1st/.test(c) && /\+15/.test(c)), 'fastest correct answer should get 15 points: ' + chips.join(' | '));
  assert(chips.filter(c => /\+1[25]|\+10|\+8/.test(c)).length === 2, 'two players answered correctly: ' + chips.join(' | '));
  await page.evaluate(() => { window.ZING.transport.mode = 'local'; });
  await page.click('.btn.primary');   // next round (host)
  await page.waitForSelector('.pass-hero');

  /* ---------- Categories: host picks one or many; the pool follows ---------- */
  const catCheck = await page.evaluate(() => {
    const out = {};
    window.ZING.setGroups(['dingbats']);
    out.dingbatsOnly = window.ZING.activePool().every(q => q.type === 'dingbat') && window.ZING.activePool().length >= 40;
    window.ZING.setGroups(['e1960']);
    const p60 = window.ZING.activePool();
    out.sixtiesHasMusicAndNews = p60.some(q => q.type === 'music' && q.decade === 1960) && p60.some(q => q.era === 1960);
    out.sixtiesNoOtherDecades = p60.every(q => !q.decade || q.decade === 1960);
    window.ZING.setGroups(['xmas']);
    out.xmasOnly = window.ZING.activePool().every(q => q.cat === 'Christmas');
    window.ZING.setGroups(null);
    const all = window.ZING.activePool();
    out.defaultExcludesXmas = !all.some(q => q.cat === 'Christmas');
    out.defaultIncludesFaces = all.some(q => q.type === 'face') || !window.ZING.pool.some(q => q.type === 'face');
    out.pickedDingbatAtKid = (() => { window.ZING.setGroups(['dingbats']); const q = window.ZING.pickAtLevel(1, {}, null); window.ZING.setGroups(null); return q.type === 'dingbat'; })();
    // every question maps to at least one group
    out.allTagged = window.ZING.pool.every(q => q.groups && q.groups.length);
    // prepare a dingbat and a face
    const d = window.ZING.prepare(window.ZING.pool.find(q => q.type === 'dingbat'));
    out.dingbatOk = d.options.length === 4 && d.options[d.answer] && d.spec && d.spec.items.length > 0;
    const f = window.ZING.pool.find(q => q.type === 'face');
    if (f) { let who = 0, mash = 0, bad = 0; for (let i = 0; i < 60; i++) { const q = window.ZING.prepare(f); if (q.form === 'mash') mash++; else who++; if (q.options.length !== 4 || !q.options[q.answer] || !q.img) bad++; } out.faceOk = who > 0 && mash > 0 && bad === 0; } else out.faceOk = 'no faces';
    return out;
  });
  Object.keys(catCheck).forEach(k => assert(catCheck[k] === true || catCheck[k] === 'no faces', 'category check failed: ' + k + ' = ' + catCheck[k]));
  console.log('Categories OK', catCheck.faceOk === 'no faces' ? '(no faces bundled yet)' : '(faces OK)');

  // Dingbats-only game renders the puzzle and reveals it
  await page.click('text=Quit');
  await page.click('text=Play on this phone');
  await page.click('text=Next');
  await page.click('text=Turn by turn');
  await page.click('.setting button:has-text("ategories")');
  await page.click('text=Clear');
  await page.click('.cat-chip >> text=Dingbats');
  await page.click('text=Done');
  await page.click('text=Start game');
  await page.waitForSelector('.pass-hero');
  await page.click('.btn.primary');
  await page.waitForSelector('.dingbat');
  assert.strictEqual(await page.locator('.q-meta .cat:last-child').textContent().then(t => t.includes('Dingbat')), true);
  await page.click('.answers .ans >> nth=0');
  await page.waitForSelector('.result');
  await page.click('.result .btn.primary');
  // reset categories to all for later runs
  await page.evaluate(() => { const o = JSON.parse(localStorage.getItem('zing.gameOpts')); o.cats = null; localStorage.setItem('zing.gameOpts', JSON.stringify(o)); });
  await page.click('text=Quit');

  /* ---------- Settings persist ---------- */
  await page.click('text=Settings');
  await page.click('text=Dyslexia');
  assert.strictEqual(await page.evaluate(() => document.documentElement.getAttribute('data-font')), 'dyslexic');
  await page.reload();
  await page.waitForSelector('.logo');
  assert.strictEqual(await page.evaluate(() => document.documentElement.getAttribute('data-font')), 'dyslexic', 'font setting should persist');
  assert.strictEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('zing.players')).length), 3, 'players should persist');

  // Link phones screen explains itself in the web preview
  await page.click('text=Link phones');
  await page.waitForSelector('text=needs the Zing app');

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert(!overflow, 'page overflows horizontally');

  await browser.close();
  if (errors.length) { console.error('Browser errors:', errors); process.exit(1); }
  console.log('All game tests passed.');
})().catch(e => { console.error(e); process.exit(1); });
