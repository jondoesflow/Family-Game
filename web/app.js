/* Zing Quiz — game engine and screens. Plain JS, no build step. */
(function () {
  "use strict";

  /* ---------------- Native bridge (iOS shell) ---------------- */
  var Native = {
    has: function () { return !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.zing); },
    post: function (msg) { try { window.webkit.messageHandlers.zing.postMessage(msg); } catch (e) {} },
    haptic: function (kind) { if (Native.has()) Native.post({ type: "haptic", kind: kind }); },
    speak: function (text) {
      if (!settings.readAloud && !speakRequested) return;
      if (Native.has()) { Native.post({ type: "speak", text: text }); return; }
      try {
        if (!window.speechSynthesis) return;
        window.speechSynthesis.cancel();
        var u = new SpeechSynthesisUtterance(text);
        u.lang = "en-GB"; u.rate = 0.95;
        var voices = window.speechSynthesis.getVoices();
        for (var i = 0; i < voices.length; i++) { if (voices[i].lang === "en-GB") { u.voice = voices[i]; break; } }
        window.speechSynthesis.speak(u);
      } catch (e) {}
    },
    stopSpeaking: function () {
      if (Native.has()) { Native.post({ type: "stopSpeak" }); return; }
      try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) {}
    }
  };
  var speakRequested = false;

  /* ---------------- Storage ---------------- */
  function load(key, fallback) { try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } }
  function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }

  var settings = Object.assign({ size: "normal", font: "clear", motion: "full", sounds: true, readAloud: false }, load("zing.settings", {}));
  var players = load("zing.players", []);
  var seen = load("zing.seen", {});
  var gameOpts = Object.assign({ length: 8, timer: 0 }, load("zing.gameOpts", {}));

  function applySettings() {
    var html = document.documentElement;
    html.setAttribute("data-size", settings.size);
    html.setAttribute("data-font", settings.font === "dyslexic" ? "dyslexic" : settings.font === "system" ? "system" : "clear");
    var reduce = settings.motion === "reduce" || (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    html.setAttribute("data-motion", reduce ? "reduce" : "full");
    Sounds.setEnabled(settings.sounds);
    save("zing.settings", settings);
  }

  /* ---------------- Content pool ---------------- */
  var AVATARS = ["🦊", "🐼", "🦄", "🐸", "🐙", "🦁", "🐧", "🐨", "🦖", "🐝", "🐬", "🦋", "🐯", "🐮", "🐵", "🦩", "🐢", "🦉", "🐲", "🍄", "🌟", "🚀", "🍕", "🎸"];
  // Levels: 1 Kid, 2 Family, 3 Grown-up, 4 Expert. Each age band draws from a mix of levels.
  var BANDS = { kid: { label: "Kid", sub: "Ages 8 to 12", weights: { 1: 0.85, 2: 0.15, 3: 0, 4: 0 } },
                teen: { label: "Teen", sub: "Ages 13 to 17", weights: { 1: 0.10, 2: 0.60, 3: 0.30, 4: 0 } },
                adult: { label: "Grown-up", sub: "Ages 18 to 80 and beyond", weights: { 1: 0, 2: 0.20, 3: 0.55, 4: 0.25 } } };
  var CAT_COLOURS = {};
  var CAT_PALETTE = ["#ff5e7e", "#ffb443", "#2ed3b7", "#8b6cff", "#ff8c42", "#3cb4ff", "#e85cff", "#6ee7b7", "#f472b6", "#fbbf24"];

  function buildPool() {
    var pool = [];
    var C = window.CONTENT || {};
    var X = window.CONTENT_EXTRA || {};
    var T = window.CONTENT_TRIVIA || {};
    (C.quiz || []).forEach(function (q) { pool.push(Object.assign({ type: "mc" }, q)); });
    (X.quiz || []).forEach(function (q) { pool.push(Object.assign({ type: "mc" }, q)); });
    (C.emoji || []).forEach(function (q) { pool.push(Object.assign({ type: "emoji" }, q)); });
    (X.flags || []).forEach(function (q) { pool.push(Object.assign({ type: "emoji" }, q)); });
    (X.tf || []).forEach(function (q) { pool.push(Object.assign({ type: "tf" }, q)); });
    (T.quiz || []).forEach(function (q) { pool.push(Object.assign({ type: "mc" }, q)); });
    (T.tf || []).forEach(function (q) { pool.push(Object.assign({ type: "tf" }, q)); });
    var ci = 0;
    pool.forEach(function (q) { if (!CAT_COLOURS[q.cat]) { CAT_COLOURS[q.cat] = CAT_PALETTE[ci % CAT_PALETTE.length]; ci++; } });
    return pool;
  }
  var POOL = buildPool();

  function weightedPick(weights) {
    var r = Math.random(), acc = 0, keys = Object.keys(weights);
    for (var i = 0; i < keys.length; i++) { acc += weights[keys[i]]; if (r <= acc) return keys[i]; }
    return keys[keys.length - 1];
  }
  function shuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

  // Pick a question for a player: random type, level by age band, never repeated within a game,
  // and not shown in previous games until the whole pool has been used.
  function pickQuestion(player, usedIds, lastCat) {
    var level = parseInt(weightedPick(BANDS[player.band].weights), 10);
    var type = weightedPick({ mc: 0.55, emoji: 0.27, tf: 0.18 });
    var attempts = [
      function (q) { return q.level === level && q.type === type && !usedIds[q.id] && !seen[q.id] && q.cat !== lastCat; },
      function (q) { return q.level === level && q.type === type && !usedIds[q.id] && !seen[q.id]; },
      function (q) { return q.level === level && !usedIds[q.id] && !seen[q.id]; },
      function (q) { return Math.abs(q.level - level) <= 1 && !usedIds[q.id] && !seen[q.id]; },
      function (q) { return q.level === level && !usedIds[q.id]; },
      function (q) { return !usedIds[q.id]; },
      function (q) { return true; }
    ];
    for (var i = 0; i < attempts.length; i++) {
      var cands = POOL.filter(attempts[i]);
      if (cands.length) {
        if (i >= 4) { seen = {}; save("zing.seen", seen); } // pool exhausted for this level: start the cycle again
        return cands[Math.floor(Math.random() * cands.length)];
      }
    }
    return POOL[0];
  }

  /* ---------------- DOM helpers ---------------- */
  var app = document.getElementById("app");
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") e.className = attrs[k];
      else if (k === "text") e.textContent = attrs[k];
      else if (k === "html") e.innerHTML = attrs[k];
      else if (k.indexOf("on") === 0) e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c === null || c === undefined) return; e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function btn(label, onClick, cls, attrs) {
    var b = el("button", Object.assign({ class: "btn " + (cls || ""), type: "button" }, attrs || {}), [label]);
    b.addEventListener("click", function (ev) { Sounds.unlock(); Sounds.tap(); Native.haptic("light"); onClick(ev, b); });
    return b;
  }
  function show(screenEl) {
    Native.stopSpeaking();
    app.innerHTML = "";
    app.appendChild(screenEl);
    app.scrollTop = 0;
  }
  function toast(msg) {
    var t = el("div", { class: "toast", role: "status", text: msg });
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 1800);
  }
  function avatarEl(p, big) { return el("div", { class: "avatar" + (big ? " big" : ""), "aria-hidden": "true", text: p.avatar }); }
  var SHAPES = ["▲", "●", "■", "◆"];
  var LETTERS = ["A", "B", "C", "D"];

  /* ---------------- Screens ---------------- */
  function screenHome() {
    var s = el("section", { class: "screen center", "aria-label": "Home" });
    s.appendChild(el("div", { class: "grow" }));
    s.appendChild(el("div", { class: "logo" }, [el("span", { class: "logo-bolt", "aria-hidden": "true", text: "⚡" }), "ZING"]));
    s.appendChild(el("p", { class: "tagline", text: "The quiz for everyone. 8 to 80." }));
    s.appendChild(el("div", { class: "grow" }));
    var stack = el("div", { class: "stack" });
    stack.appendChild(btn("▶  Play", function () { show(screenPlayers()); }, "primary"));
    var row = el("div", { class: "btn-row" });
    row.appendChild(btn("How to play", function () { show(screenHowTo()); }, "ghost"));
    row.appendChild(btn("⚙︎ Settings", function () { show(screenSettings()); }, "ghost"));
    stack.appendChild(row);
    s.appendChild(stack);
    s.appendChild(el("p", { class: "muted small", text: POOL.length + " questions ready. One phone. Pass it round." }));
    return s;
  }

  function screenHowTo() {
    var s = el("section", { class: "screen", "aria-label": "How to play" });
    s.appendChild(el("div", { class: "topbar" }, [btn("‹ Back", function () { show(screenHome()); }, "ghost slim"), el("span", { class: "title", text: "How to play" }), el("span")]));
    var card = el("div", { class: "card howto" });
    card.appendChild(el("h2", { text: "One phone. Everyone plays." }));
    card.appendChild(el("ul", {}, [
      el("li", { text: "Add each player and pick their age group. Kids get kid questions. Grown-ups get harder ones. Same scoreboard." }),
      el("li", { text: "Pass the phone to the player named on screen." }),
      el("li", { text: "Read the question. Tap the big 🔊 button to hear it read out." }),
      el("li", { text: "Tap one answer. You get 10 points for a right answer." }),
      el("li", { text: "Three right in a row is a streak. Streaks earn bonus points." }),
      el("li", { text: "Highest score at the end wins the crown." })
    ]));
    s.appendChild(card);
    var card2 = el("div", { class: "card" });
    card2.appendChild(el("h3", { text: "Question types" }));
    card2.appendChild(el("p", { html: "<b>Multiple choice</b>: four answers, each with its own colour, letter and shape.<br><b>Emoji puzzles</b>: work out the film, place or flag from the emojis.<br><b>True or false</b>: two big buttons. Trust your gut." }));
    s.appendChild(card2);
    return s;
  }

  function screenSettings() {
    var s = el("section", { class: "screen", "aria-label": "Settings" });
    s.appendChild(el("div", { class: "topbar" }, [btn("‹ Back", function () { show(screenHome()); }, "ghost slim"), el("span", { class: "title", text: "Settings" }), el("span")]));

    function seg(label, key, options) {
      var wrap = el("div", { class: "setting" });
      wrap.appendChild(el("span", { class: "label", text: label }));
      var g = el("div", { class: "seg", role: "radiogroup", "aria-label": label });
      options.forEach(function (o) {
        var b = btn("", function () { settings[key] = o.value; applySettings(); show(screenSettings()); }, "", { role: "radio", "aria-pressed": String(settings[key] === o.value), "aria-checked": String(settings[key] === o.value) });
        b.appendChild(el("span", { text: o.label }));
        if (o.sub) b.appendChild(el("span", { class: "sub", text: o.sub }));
        g.appendChild(b);
      });
      wrap.appendChild(g);
      return wrap;
    }
    function toggle(title, desc, key) {
      var sw = el("button", { class: "switch", type: "button", role: "switch", "aria-checked": String(!!settings[key]), "aria-label": title });
      sw.addEventListener("click", function () { settings[key] = !settings[key]; applySettings(); sw.setAttribute("aria-checked", String(!!settings[key])); Sounds.unlock(); Sounds.tap(); Native.haptic("light"); });
      return el("div", { class: "toggle-row" }, [el("div", {}, [el("span", { class: "t", text: title }), el("span", { class: "d", text: desc })]), sw]);
    }

    s.appendChild(seg("Text size", "size", [{ label: "Normal", value: "normal" }, { label: "Large", value: "large" }, { label: "Huge", value: "huge" }]));
    s.appendChild(seg("Font", "font", [{ label: "Clear", value: "clear", sub: "Hyperlegible" }, { label: "Dyslexia", value: "dyslexic", sub: "OpenDyslexic" }, { label: "Phone", value: "system", sub: "System font" }]));
    s.appendChild(seg("Motion", "motion", [{ label: "Full", value: "full", sub: "Confetti & glow" }, { label: "Calm", value: "reduce", sub: "Less movement" }]));
    s.appendChild(toggle("Funny noises", "Cheers, boings and sad trombones.", "sounds"));
    s.appendChild(toggle("Read questions aloud", "Every question is spoken automatically.", "readAloud"));
    s.appendChild(btn("Test a noise 🔊", function () { Math.random() < 0.5 ? Sounds.correct() : Sounds.wrong(); }, "ghost"));
    s.appendChild(btn("Forget which questions I've seen", function () { seen = {}; save("zing.seen", seen); toast("Question history cleared"); }, "ghost"));
    s.appendChild(el("p", { class: "muted small center", text: "Zing Quiz · " + POOL.length + " questions · made for families" }));
    s.appendChild(el("p", { class: "muted small center", text: "Includes questions from the Open Trivia Database (opentdb.com), CC BY-SA 4.0." }));
    return s;
  }

  /* ---------- Players ---------- */
  function screenPlayers() {
    var s = el("section", { class: "screen", "aria-label": "Players" });
    s.appendChild(el("div", { class: "topbar" }, [btn("‹ Home", function () { show(screenHome()); }, "ghost slim"), el("span", { class: "title", text: "Who's playing?" }), el("span")]));
    var list = el("div", { class: "player-list" });
    if (!players.length) list.appendChild(el("p", { class: "muted center", text: "Add at least 2 players to start." }));
    players.forEach(function (p, i) {
      var row = el("div", { class: "player-row" });
      row.appendChild(avatarEl(p));
      row.appendChild(el("div", { class: "name" }, [p.name, el("span", { class: "band", text: BANDS[p.band].label + " · " + BANDS[p.band].sub })]));
      var rm = el("button", { class: "remove", type: "button", "aria-label": "Remove " + p.name, text: "✕" });
      rm.addEventListener("click", function () { players.splice(i, 1); save("zing.players", players); show(screenPlayers()); });
      row.appendChild(rm);
      list.appendChild(row);
    });
    s.appendChild(list);
    s.appendChild(btn("＋ Add a player", function () { show(screenAddPlayer()); }, players.length < 8 ? "" : "", { disabled: players.length >= 8 ? "true" : null }));
    s.appendChild(el("div", { class: "grow" }));
    s.appendChild(btn("Next  ›", function () { show(screenSetup()); }, "primary", { disabled: players.length < 2 ? "true" : null }));
    return s;
  }

  function screenAddPlayer() {
    var draft = { name: "", avatar: AVATARS.filter(function (a) { return !players.some(function (p) { return p.avatar === a; }); })[0] || "🙂", band: "adult" };
    var s = el("section", { class: "screen", "aria-label": "Add a player" });
    s.appendChild(el("div", { class: "topbar" }, [btn("‹ Back", function () { show(screenPlayers()); }, "ghost slim"), el("span", { class: "title", text: "New player" }), el("span")]));
    var input = el("input", { type: "text", id: "player-name", placeholder: "Name", maxlength: "14", autocomplete: "off", autocapitalize: "words", "aria-label": "Player name", enterkeyhint: "done" });
    input.addEventListener("input", function () { draft.name = input.value.trim(); addBtn.disabled = !draft.name; });
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") { input.blur(); if (draft.name) addBtn.click(); } });
    s.appendChild(el("div", { class: "setting" }, [el("span", { class: "label", text: "Name" }), input]));

    var grid = el("div", { class: "avatar-grid", role: "radiogroup", "aria-label": "Pick a picture" });
    AVATARS.forEach(function (a) {
      var b = el("button", { type: "button", role: "radio", "aria-label": a, "aria-pressed": String(a === draft.avatar), "aria-checked": String(a === draft.avatar), text: a });
      b.addEventListener("click", function () { draft.avatar = a; Sounds.tap(); Native.haptic("light"); Array.prototype.forEach.call(grid.children, function (c) { c.setAttribute("aria-pressed", String(c.textContent === a)); c.setAttribute("aria-checked", String(c.textContent === a)); }); });
      grid.appendChild(b);
    });
    s.appendChild(el("div", { class: "setting" }, [el("span", { class: "label", text: "Pick a picture" }), grid]));

    var bands = el("div", { class: "band-grid", role: "radiogroup", "aria-label": "Age group" });
    Object.keys(BANDS).forEach(function (k) {
      var b = btn("", function () { draft.band = k; Array.prototype.forEach.call(bands.children, function (c) { c.setAttribute("aria-pressed", String(c.getAttribute("data-band") === k)); }); }, "", { "data-band": k, role: "radio", "aria-pressed": String(k === draft.band) });
      b.appendChild(el("span", {}, [BANDS[k].label, el("span", { class: "sub", text: BANDS[k].sub + " · questions pitched for this age" })]));
      bands.appendChild(b);
    });
    s.appendChild(el("div", { class: "setting" }, [el("span", { class: "label", text: "Age group (sets question difficulty)" }), bands]));

    var addBtn = btn("Add player ✓", function () {
      if (!draft.name) return;
      players.push({ name: draft.name, avatar: draft.avatar, band: draft.band });
      save("zing.players", players);
      show(screenPlayers());
    }, "primary", { disabled: "true" });
    s.appendChild(addBtn);
    setTimeout(function () { try { input.focus(); } catch (e) {} }, 50);
    return s;
  }

  function screenSetup() {
    var s = el("section", { class: "screen", "aria-label": "Game setup" });
    s.appendChild(el("div", { class: "topbar" }, [btn("‹ Players", function () { show(screenPlayers()); }, "ghost slim"), el("span", { class: "title", text: "Game setup" }), el("span")]));
    function seg(label, key, options) {
      var wrap = el("div", { class: "setting" });
      wrap.appendChild(el("span", { class: "label", text: label }));
      var g = el("div", { class: "seg", role: "radiogroup", "aria-label": label });
      options.forEach(function (o) {
        var b = btn("", function () { gameOpts[key] = o.value; save("zing.gameOpts", gameOpts); show(screenSetup()); }, "", { role: "radio", "aria-pressed": String(gameOpts[key] === o.value) });
        b.appendChild(el("span", { text: o.label }));
        if (o.sub) b.appendChild(el("span", { class: "sub", text: o.sub }));
        g.appendChild(b);
      });
      wrap.appendChild(g);
      return wrap;
    }
    s.appendChild(seg("Game length", "length", [{ label: "Quick", value: 5, sub: "5 questions each" }, { label: "Normal", value: 8, sub: "8 questions each" }, { label: "Long", value: 12, sub: "12 questions each" }]));
    s.appendChild(seg("Timer", "timer", [{ label: "Relaxed", value: 0, sub: "No timer" }, { label: "Gentle", value: 25, sub: "25 seconds" }, { label: "Speedy", value: 12, sub: "12 seconds" }]));
    var strip = el("div", { class: "score-strip" });
    players.forEach(function (p) { strip.appendChild(el("span", { class: "chip" }, [el("span", { class: "avatar", text: p.avatar }), p.name])); });
    s.appendChild(el("div", { class: "setting" }, [el("span", { class: "label", text: "Playing" }), strip]));
    s.appendChild(el("div", { class: "grow" }));
    s.appendChild(btn("Start game  ⚡", function () { startGame(); }, "primary"));
    return s;
  }

  /* ---------------- Game state ---------------- */
  var G = null;
  function startGame() {
    G = {
      players: players.map(function (p) { return Object.assign({}, p, { score: 0, streak: 0, correct: 0, lastCat: null }); }),
      round: 0, turn: 0, total: gameOpts.length, used: {}
    };
    show(screenPass());
  }
  function currentPlayer() { return G.players[G.turn]; }

  function screenPass() {
    var p = currentPlayer();
    var s = el("section", { class: "screen", "aria-label": "Pass the phone" });
    s.appendChild(el("div", { class: "topbar" }, [btn("✕ Quit", function () { show(screenHome()); }, "ghost slim"), el("span", { class: "chip", text: "Question " + (G.round + 1) + " of " + G.total }), el("span")]));
    s.appendChild(el("div", { class: "grow" }));
    var hero = el("div", { class: "pass-hero" });
    hero.appendChild(el("p", { class: "lead muted", text: "Pass the phone to" }));
    hero.appendChild(avatarEl(p, true));
    hero.appendChild(el("div", { class: "name", text: p.name }));
    hero.appendChild(el("p", { class: "muted", text: p.score + " points" + (p.streak >= 2 ? " · 🔥 " + p.streak + " in a row" : "") }));
    s.appendChild(hero);
    s.appendChild(el("div", { class: "grow" }));
    var strip = el("div", { class: "score-strip" });
    G.players.slice().sort(function (a, b) { return b.score - a.score; }).forEach(function (q) { strip.appendChild(el("span", { class: "chip" }, [el("span", { class: "avatar", text: q.avatar }), String(q.score)])); });
    s.appendChild(strip);
    s.appendChild(btn("I'm " + p.name + ". Ready!  ›", function () { Sounds.whoosh(); showQuestion(); }, "primary"));
    return s;
  }

  function showQuestion() {
    var p = currentPlayer();
    var q = pickQuestion(p, G.used, p.lastCat);
    G.used[q.id] = true; seen[q.id] = true; save("zing.seen", seen);
    p.lastCat = q.cat;

    var options, correctIdx;
    if (q.type === "tf") { options = ["True", "False"]; correctIdx = q.answer ? 0 : 1; }
    else {
      var idx = shuffle([0, 1, 2, 3]);
      options = idx.map(function (i) { return q.options[i]; });
      correctIdx = idx.indexOf(q.answer);
    }

    var s = el("section", { class: "screen", "aria-label": "Question" });
    s.appendChild(el("div", { class: "q-head" }, [
      el("span", { class: "chip" }, [el("span", { class: "avatar", text: p.avatar }), p.name]),
      el("span", { class: "chip", text: "Q" + (G.round + 1) + "/" + G.total + " · " + p.score + " pts" })
    ]));
    var timerBar = null, timerFill = null;
    if (gameOpts.timer) { timerFill = el("div"); timerBar = el("div", { class: "timer", "aria-hidden": "true" }, [timerFill]); s.appendChild(timerBar); }

    var card = el("div", { class: "card q-card" });
    var typeLabel = q.type === "tf" ? "True or false?" : q.type === "emoji" ? "Emoji puzzle" : "Multiple choice";
    card.appendChild(el("div", { class: "q-meta" }, [
      el("span", { class: "cat" }, [el("span", { class: "dot", style: "background:" + (CAT_COLOURS[q.cat] || "#999") }), q.cat]),
      el("span", { class: "cat", text: typeLabel })
    ]));
    if (q.prompt) card.appendChild(el("div", { class: "q-prompt", role: "img", "aria-label": "Emoji clue", text: q.prompt }));
    card.appendChild(el("p", { class: "q-text", id: "q-text", text: q.q }));
    var speakText = q.q + (q.type === "tf" ? " True or false?" : ". " + options.map(function (o, i) { return LETTERS[i] + ". " + o; }).join(". "));
    var speakBtn = el("button", { class: "speak", type: "button", "aria-label": "Read the question aloud" }, ["🔊 ", "Read it to me"]);
    speakBtn.addEventListener("click", function () { speakRequested = true; Native.speak(speakText); speakRequested = false; });
    card.appendChild(speakBtn);
    s.appendChild(card);

    var answers = el("div", { class: "answers" + (q.type === "tf" ? " two" : ""), role: "group", "aria-label": "Answers" });
    var buttons = options.map(function (opt, i) {
      var b = el("button", { class: "ans" + (q.type === "tf" ? (i === 0 ? " true" : " false") : ""), type: "button", "data-k": String(i) });
      if (q.type === "tf") { b.appendChild(el("span", { class: "badge", text: i === 0 ? "✓" : "✗" })); b.appendChild(el("span", { class: "txt", text: opt })); }
      else { b.appendChild(el("span", { class: "badge" }, [LETTERS[i], el("span", { class: "shape", text: SHAPES[i] })])); b.appendChild(el("span", { class: "txt", text: opt })); }
      b.addEventListener("click", function () { answer(i); });
      answers.appendChild(b);
      return b;
    });
    s.appendChild(answers);
    var resultHolder = el("div");
    s.appendChild(resultHolder);
    show(s);
    if (settings.readAloud) setTimeout(function () { Native.speak(speakText); }, 350);

    var start = Date.now(), done = false, raf = null, lastTick = -1;
    if (gameOpts.timer) {
      var tick = function () {
        if (done) return;
        var elapsed = (Date.now() - start) / 1000;
        var frac = Math.max(0, 1 - elapsed / gameOpts.timer);
        timerFill.style.transform = "scaleX(" + frac + ")";
        var secLeft = Math.ceil(gameOpts.timer - elapsed);
        if (secLeft <= 3 && secLeft !== lastTick && secLeft > 0) { lastTick = secLeft; Sounds.tick(); }
        if (frac <= 0) { answer(-1); return; }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    function answer(i) {
      if (done) return; done = true;
      if (raf) cancelAnimationFrame(raf);
      Native.stopSpeaking();
      answers.classList.add("locked");
      var right = i === correctIdx;
      var elapsed = (Date.now() - start) / 1000;
      var pts = 0, bonus = 0, streakBonus = 0;
      if (right) {
        pts = 10;
        if (gameOpts.timer) bonus = Math.max(0, Math.round(5 * (1 - elapsed / gameOpts.timer)));
        p.streak += 1; p.correct += 1;
        if (p.streak >= 3) streakBonus = 5;
        p.score += pts + bonus + streakBonus;
      } else { p.streak = 0; }

      buttons.forEach(function (b, k) {
        if (k === correctIdx) { b.classList.add("correct"); b.appendChild(el("span", { class: "mark", text: "✓" })); }
        else if (k === i) { b.classList.add("wrong"); b.appendChild(el("span", { class: "mark", text: "✗" })); }
        else b.classList.add("dim");
      });
      if (right) { Sounds.correct(); Native.haptic("success"); confettiBurst(p.streak >= 3 ? 220 : 120); if (streakBonus) setTimeout(Sounds.streak, 500); }
      else { if (i === -1) Sounds.timeUp(); else Sounds.wrong(); Native.haptic("error"); card.classList.add("shake"); }

      var res = el("div", { class: "card result pop " + (right ? "good" : "bad") });
      var verdicts = right ? ["Correct!", "Yes!", "Nailed it!", "Spot on!", "Brilliant!", "You got it!"] : i === -1 ? ["Out of time!"] : ["Not this time", "Oops!", "So close", "Nope!"];
      res.appendChild(el("div", { class: "verdict", text: verdicts[Math.floor(Math.random() * verdicts.length)] }));
      if (right) {
        var line = "+" + pts + " points";
        if (bonus) line += " · +" + bonus + " speed";
        if (streakBonus) line += " · 🔥 +" + streakBonus + " streak";
        res.appendChild(el("div", { class: "points", text: line }));
      } else {
        res.appendChild(el("div", { class: "points", text: "The answer was: " + options[correctIdx] }));
      }
      if (q.fact) res.appendChild(el("p", { class: "fact", text: q.fact }));
      var nextBtn = btn("Next  ›", function () { nextTurn(); }, "primary");
      res.appendChild(nextBtn);
      resultHolder.appendChild(res);
      setTimeout(function () { try { nextBtn.scrollIntoView({ behavior: settings.motion === "reduce" ? "auto" : "smooth", block: "end" }); } catch (e) {} }, 60);
    }
  }

  function nextTurn() {
    G.turn += 1;
    if (G.turn >= G.players.length) {
      G.turn = 0; G.round += 1;
      if (G.round >= G.total) { show(screenFinal()); return; }
      show(screenBoard()); return;
    }
    show(screenPass());
  }

  function boardRows(container, animate) {
    var sorted = G.players.slice().sort(function (a, b) { return b.score - a.score; });
    var max = Math.max(1, sorted[0].score);
    sorted.forEach(function (p, i) {
      var row = el("div", { class: "bar-row" + (i === 0 && p.score > 0 ? " leader" : "") });
      row.appendChild(avatarEl(p));
      var fill = el("div", { class: "fill" });
      fill.style.width = animate ? "6%" : (Math.max(6, 100 * p.score / max)) + "%";
      row.appendChild(el("div", { class: "track" }, [fill, el("span", { class: "nm", text: p.name })]));
      row.appendChild(el("div", { class: "pts", text: String(p.score) }));
      container.appendChild(row);
      if (animate) setTimeout(function () { fill.style.width = Math.max(6, 100 * p.score / max) + "%"; }, 80);
    });
  }

  function screenBoard() {
    var s = el("section", { class: "screen", "aria-label": "Scores" });
    s.appendChild(el("div", { class: "topbar" }, [el("span"), el("span", { class: "title", text: "Scores after round " + G.round }), el("span")]));
    var board = el("div", { class: "board" });
    boardRows(board, true);
    s.appendChild(board);
    s.appendChild(el("div", { class: "grow" }));
    s.appendChild(el("p", { class: "muted center", text: (G.total - G.round) + (G.total - G.round === 1 ? " question" : " questions") + " each to go" }));
    s.appendChild(btn("Keep going  ›", function () { show(screenPass()); }, "primary"));
    return s;
  }

  function screenFinal() {
    var sorted = G.players.slice().sort(function (a, b) { return b.score - a.score; });
    var top = sorted[0];
    var tied = sorted.filter(function (p) { return p.score === top.score; });
    var s = el("section", { class: "screen", "aria-label": "Final results" });
    s.appendChild(el("div", { class: "topbar" }, [el("span"), el("span", { class: "title", text: "Final results" }), el("span")]));
    s.appendChild(el("div", { class: "crown center", "aria-hidden": "true", text: "👑" }));
    s.appendChild(el("div", { class: "winner-line", text: tied.length > 1 ? "It's a tie!" : top.name + " wins!" }));
    var pod = el("div", { class: "podium" });
    var order = [sorted[1], sorted[0], sorted[2]];
    ["p2", "p1", "p3"].forEach(function (cls, i) {
      var p = order[i];
      var step = el("div", { class: "step " + cls });
      if (p) { step.appendChild(avatarEl(p)); step.appendChild(el("div", { class: "nm", text: p.name })); step.appendChild(el("div", { class: "block", text: String(p.score) })); }
      else step.appendChild(el("div", { class: "block", style: "visibility:hidden" }));
      pod.appendChild(step);
    });
    s.appendChild(pod);
    if (sorted.length > 3) { var board = el("div", { class: "board" }); boardRows(board, false); s.appendChild(board); }
    var best = G.players.slice().sort(function (a, b) { return b.correct - a.correct; })[0];
    s.appendChild(el("p", { class: "muted center", text: "Most right answers: " + best.name + " (" + best.correct + ")" }));
    s.appendChild(el("div", { class: "grow" }));
    var row = el("div", { class: "btn-row" });
    row.appendChild(btn("Play again", function () { startGame(); }, "primary"));
    row.appendChild(btn("Home", function () { show(screenHome()); }, "ghost"));
    s.appendChild(row);
    setTimeout(function () { Sounds.fanfare(); Native.haptic("success"); confettiBurst(400); setTimeout(function () { confettiBurst(300); }, 900); }, 300);
    return s;
  }

  /* ---------------- Confetti ---------------- */
  var canvas = document.getElementById("confetti"), cctx = canvas.getContext("2d"), parts = [], animating = false;
  function resize() { canvas.width = window.innerWidth * (window.devicePixelRatio || 1); canvas.height = window.innerHeight * (window.devicePixelRatio || 1); }
  window.addEventListener("resize", resize); resize();
  var COLS = ["#ff5e7e", "#ffb443", "#2ed3b7", "#8b6cff", "#ffe066", "#ffffff"];
  function confettiBurst(n) {
    if (document.documentElement.getAttribute("data-motion") === "reduce") n = Math.min(n, 40);
    var dpr = window.devicePixelRatio || 1;
    for (var i = 0; i < n; i++) {
      parts.push({ x: canvas.width / 2 + (Math.random() - 0.5) * canvas.width * 0.4, y: canvas.height * 0.35, vx: (Math.random() - 0.5) * 18 * dpr, vy: (-Math.random() * 16 - 6) * dpr, g: 0.45 * dpr, r: (4 + Math.random() * 5) * dpr, rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3, c: COLS[Math.floor(Math.random() * COLS.length)], life: 90 + Math.random() * 60 });
    }
    if (!animating) { animating = true; requestAnimationFrame(step); }
  }
  function step() {
    cctx.clearRect(0, 0, canvas.width, canvas.height);
    parts = parts.filter(function (p) { return p.life > 0 && p.y < canvas.height + 50; });
    parts.forEach(function (p) {
      p.vy += p.g; p.x += p.vx; p.y += p.vy; p.vx *= 0.99; p.rot += p.vr; p.life -= 1;
      cctx.save(); cctx.translate(p.x, p.y); cctx.rotate(p.rot); cctx.fillStyle = p.c; cctx.globalAlpha = Math.min(1, p.life / 30);
      cctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); cctx.restore();
    });
    if (parts.length) requestAnimationFrame(step); else { animating = false; cctx.clearRect(0, 0, canvas.width, canvas.height); }
  }

  /* ---------------- Boot ---------------- */
  applySettings();
  document.addEventListener("touchstart", function () { Sounds.unlock(); }, { once: true, passive: true });
  document.addEventListener("click", function () { Sounds.unlock(); }, { once: true });
  window.ZING = { pool: POOL, pick: pickQuestion, bands: BANDS, start: startGame, players: function () { return players; } };
  show(screenHome());
})();
