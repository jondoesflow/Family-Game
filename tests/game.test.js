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
  assert.deepStrictEqual(poolInfo.types, ['emoji', 'mc', 'tf']);

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
      seenQ[name] = await page.textContent('.q-text');
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

  /* ---------- Settings persist ---------- */
  await page.click('text=Home');
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
