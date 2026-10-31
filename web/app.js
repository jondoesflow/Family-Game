/* Zing Quiz — game engine and screens. Plain JS, no build step.
   Modes:
     Classic  — pass the phone, each player gets their own question, instant reveal.
     Shared   — turn by turn: everyone in the same age group gets the same question each round,
                answers are locked in, then the round is revealed together.
     Linked   — Shared mode across several phones (host + joiners) over Multipeer (Bluetooth / peer Wi-Fi).
   Shared and Linked both run on a small host/client engine; on one phone the host and client live in the same page. */
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

  /* ---------------- Multipeer bridge (phones linking) ---------------- */
  var Net = {
    available: function () { return Native.has() && !!window.__ZING_MP__; },
    me: null, hosts: [], peers: [], onEvent: null,
    host: function (name) { Native.post({ type: "mp", cmd: "host", name: name }); },
    join: function (name) { Native.post({ type: "mp", cmd: "join", name: name }); },
    invite: function (peerId) { Native.post({ type: "mp", cmd: "invite", peer: peerId }); },
    send: function (to, obj) { Native.post({ type: "mp", cmd: "send", to: to || "", payload: JSON.stringify(obj) }); },
    stop: function () { Net.me = null; Net.hosts = []; Net.peers = []; if (Native.has()) Native.post({ type: "mp", cmd: "stop" }); },
    _event: function (ev) {
      if (ev.kind === "ready") Net.me = ev.me;
      if (ev.kind === "found") Net.hosts = ev.peers || [];
      if (ev.kind === "peers") Net.peers = ev.peers || [];
      if (Net.onEvent) { try { Net.onEvent(ev); } catch (e) { console.error(e); } }
    }
  };
  window.ZingNet = Net;
  function peerLabel(id) { return String(id || "").replace(/#[A-Za-z0-9]+$/, ""); }

  /* ---------------- Storage ---------------- */
  function load(key, fallback) { try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } }
  function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }

  var settings = Object.assign({ size: "normal", font: "clear", motion: "full", sounds: true, readAloud: false }, load("zing.settings", {}));
  var players = load("zing.players", []);
  var seen = load("zing.seen", {});
  var gameOpts = Object.assign({ length: 8, timer: 0, mode: "shared", teams: false }, load("zing.gameOpts", {}));
  players.forEach(function (p, i) { if (!p.id) p.id = "p" + Date.now().toString(36) + i; if (p.team === undefined) p.team = null; });

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
  var LEVEL_NAMES = { 1: "Kid", 2: "Family", 3: "Grown-up", 4: "Expert" };
  var TEAMS = [{ id: "red", name: "Red", emoji: "🔴", colour: "#ff5e7e" }, { id: "blue", name: "Blue", emoji: "🔵", colour: "#3cb4ff" }, { id: "green", name: "Green", emoji: "🟢", colour: "#2ed3b7" }, { id: "yellow", name: "Yellow", emoji: "🟡", colour: "#ffb443" }];
  function teamOf(id) { for (var i = 0; i < TEAMS.length; i++) if (TEAMS[i].id === id) return TEAMS[i]; return null; }
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
    for (var i = 0; i < keys.length; i++) { acc += weights[keys[i]]; if (weights[keys[i]] > 0 && r <= acc) return keys[i]; }
    for (var j = keys.length - 1; j >= 0; j--) if (weights[keys[j]] > 0) return keys[j];
    return keys[0];
  }
  function shuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function pickLevel(band) { return parseInt(weightedPick(BANDS[band].weights), 10); }

  // Pick a question at a level: random type, never repeated within a game, and not shown in
  // previous games until the whole pool at that level has been used.
  function pickQuestionAtLevel(level, usedIds, lastCat) {
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
        if (i >= 4) { seen = {}; save("zing.seen", seen); }
        return cands[Math.floor(Math.random() * cands.length)];
      }
    }
    return POOL[0];
  }
  function pickQuestion(player, usedIds, lastCat) { return pickQuestionAtLevel(pickLevel(player.band), usedIds, lastCat); }

  // A question prepared for play: options shuffled, correct index recomputed. Safe to send to other phones.
  function prepareQuestion(q) {
    var out = { id: q.id, type: q.type, level: q.level, cat: q.cat, q: q.q, prompt: q.prompt || null, fact: q.fact || null };
    if (q.type === "tf") { out.options = ["True", "False"]; out.answer = q.answer ? 0 : 1; }
    else { var idx = shuffle([0, 1, 2, 3]); out.options = idx.map(function (i) { return q.options[i]; }); out.answer = idx.indexOf(q.answer); }
    return out;
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
  function show(screenEl) { Native.stopSpeaking(); app.innerHTML = ""; app.appendChild(screenEl); app.scrollTop = 0; }
  function toast(msg) { var t = el("div", { class: "toast", role: "status", text: msg }); document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2200); }
  function avatarEl(p, big) { return el("div", { class: "avatar" + (big ? " big" : ""), "aria-hidden": "true", text: p.avatar }); }
  function topbar(left, title, right) { return el("div", { class: "topbar" }, [left || el("span"), el("span", { class: "title", text: title }), right || el("span")]); }
  function seg(label, current, options, onPick) {
    var wrap = el("div", { class: "setting" });
    wrap.appendChild(el("span", { class: "label", text: label }));
    var g = el("div", { class: "seg", role: "radiogroup", "aria-label": label });
    options.forEach(function (o) {
      var b = btn("", function () { onPick(o.value); }, "", { role: "radio", "aria-pressed": String(current === o.value), "aria-checked": String(current === o.value) });
      b.appendChild(el("span", { text: o.label }));
      if (o.sub) b.appendChild(el("span", { class: "sub", text: o.sub }));
      g.appendChild(b);
    });
    wrap.appendChild(g);
    return wrap;
  }
  function toggleRow(title, desc, value, onChange) {
    var sw = el("button", { class: "switch", type: "button", role: "switch", "aria-checked": String(!!value), "aria-label": title });
    sw.addEventListener("click", function () { Sounds.unlock(); Sounds.tap(); Native.haptic("light"); var v = sw.getAttribute("aria-checked") !== "true"; sw.setAttribute("aria-checked", String(v)); onChange(v); });
    return el("div", { class: "toggle-row" }, [el("div", {}, [el("span", { class: "t", text: title }), el("span", { class: "d", text: desc })]), sw]);
  }
  var SHAPES = ["▲", "●", "■", "◆"];
  var LETTERS = ["A", "B", "C", "D"];
  function teamBadge(p, onTap) {
    var t = teamOf(p.team);
    var b = el("button", { class: "team-badge", type: "button", "aria-label": t ? t.name + " team, tap to change" : "No team, tap to pick", text: t ? t.emoji : "➕" });
    if (t) b.style.background = t.colour;
    if (onTap) b.addEventListener("click", function (e) { e.stopPropagation(); Sounds.tap(); onTap(); });
    return b;
  }
  function nextTeam(id) { var i = -1; for (var k = 0; k < TEAMS.length; k++) if (TEAMS[k].id === id) i = k; return TEAMS[(i + 1) % TEAMS.length].id; }

  /* ---------------- Home / How to / Settings ---------------- */
  function screenHome() {
    Net.stop();
    var s = el("section", { class: "screen center", "aria-label": "Home" });
    s.appendChild(el("div", { class: "grow" }));
    s.appendChild(el("div", { class: "logo" }, [el("span", { class: "logo-bolt", "aria-hidden": "true", text: "⚡" }), "ZING"]));
    s.appendChild(el("p", { class: "tagline", text: "The quiz for everyone. 8 to 80." }));
    s.appendChild(el("div", { class: "grow" }));
    var stack = el("div", { class: "stack" });
    stack.appendChild(btn("▶  Play on this phone", function () { show(screenPlayers()); }, "primary"));
    stack.appendChild(btn("📡  Link phones", function () { show(screenLink()); }, ""));
    var row = el("div", { class: "btn-row" });
    row.appendChild(btn("How to play", function () { show(screenHowTo()); }, "ghost"));
    row.appendChild(btn("⚙︎ Settings", function () { show(screenSettings()); }, "ghost"));
    stack.appendChild(row);
    s.appendChild(stack);
    s.appendChild(el("p", { class: "muted small", text: POOL.length.toLocaleString("en-GB") + " questions ready." }));
    return s;
  }

  function screenHowTo() {
    var s = el("section", { class: "screen", "aria-label": "How to play" });
    s.appendChild(topbar(btn("‹ Back", function () { show(screenHome()); }, "ghost slim"), "How to play"));
    var card = el("div", { class: "card howto" });
    card.appendChild(el("h2", { text: "One phone, or several." }));
    card.appendChild(el("ul", {}, [
      el("li", { text: "Add each player and pick their age group. Kids get kid questions, grown-ups get Trivial Pursuit level. Same scoreboard." }),
      el("li", { text: "Turn by turn: everyone in the same age group gets the same question each round. Answers lock in, then the round is revealed together." }),
      el("li", { text: "Classic: each player gets their own question and sees the answer straight away." }),
      el("li", { text: "Teams: tap the badge next to a player to put them in Red, Blue, Green or Yellow. Team scores add up." }),
      el("li", { text: "Link phones: one phone hosts, the others join over Bluetooth. Each phone holds its own players and everyone answers at the same time." }),
      el("li", { text: "10 points for a right answer, plus a speed bonus with the timer on, plus 5 for three in a row." })
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
    s.appendChild(topbar(btn("‹ Back", function () { show(screenHome()); }, "ghost slim"), "Settings"));
    function pick(key) { return function (v) { settings[key] = v; applySettings(); show(screenSettings()); }; }
    s.appendChild(seg("Text size", settings.size, [{ label: "Normal", value: "normal" }, { label: "Large", value: "large" }, { label: "Huge", value: "huge" }], pick("size")));
    s.appendChild(seg("Font", settings.font, [{ label: "Clear", value: "clear", sub: "Hyperlegible" }, { label: "Dyslexia", value: "dyslexic", sub: "OpenDyslexic" }, { label: "Phone", value: "system", sub: "System font" }], pick("font")));
    s.appendChild(seg("Motion", settings.motion, [{ label: "Full", value: "full", sub: "Confetti & glow" }, { label: "Calm", value: "reduce", sub: "Less movement" }], pick("motion")));
    s.appendChild(toggleRow("Funny noises", "Cheers, boings and sad trombones.", settings.sounds, function (v) { settings.sounds = v; applySettings(); }));
    s.appendChild(toggleRow("Read questions aloud", "Every question is spoken automatically.", settings.readAloud, function (v) { settings.readAloud = v; applySettings(); }));
    s.appendChild(btn("Test a noise 🔊", function () { Math.random() < 0.5 ? Sounds.correct() : Sounds.wrong(); }, "ghost"));
    s.appendChild(btn("Forget which questions I've seen", function () { seen = {}; save("zing.seen", seen); toast("Question history cleared"); }, "ghost"));
    s.appendChild(el("p", { class: "muted small center", text: "Zing Quiz · " + POOL.length.toLocaleString("en-GB") + " questions · made for families" }));
    s.appendChild(el("p", { class: "muted small center", text: "Includes questions from the Open Trivia Database (opentdb.com), CC BY-SA 4.0." }));
    return s;
  }

  /* ---------------- Players & setup (single phone) ---------------- */
  function playerRow(p, opts) {
    var row = el("div", { class: "player-row" });
    row.appendChild(avatarEl(p));
    row.appendChild(el("div", { class: "name" }, [p.name, el("span", { class: "band", text: BANDS[p.band].label + (opts.device ? " · " + opts.device : "") })]));
    if (opts.teams) row.appendChild(teamBadge(p, opts.onTeam));
    if (opts.onRemove) {
      var rm = el("button", { class: "remove", type: "button", "aria-label": "Remove " + p.name, text: "✕" });
      rm.addEventListener("click", opts.onRemove);
      row.appendChild(rm);
    }
    return row;
  }
  function teamsValid(list) {
    if (!gameOpts.teams) return true;
    var ids = {}; list.forEach(function (p) { if (p.team) ids[p.team] = true; });
    return list.every(function (p) { return !!p.team; }) && Object.keys(ids).length >= 2;
  }
  function autoTeams(list) { list.forEach(function (p, i) { if (!p.team) p.team = TEAMS[i % 2].id; }); }

  function screenPlayers() {
    var s = el("section", { class: "screen", "aria-label": "Players" });
    s.appendChild(topbar(btn("‹ Home", function () { show(screenHome()); }, "ghost slim"), "Who's playing?"));
    var list = el("div", { class: "player-list" });
    if (!players.length) list.appendChild(el("p", { class: "muted center", text: "Add at least 2 players to start." }));
    players.forEach(function (p, i) {
      list.appendChild(playerRow(p, {
        teams: gameOpts.teams,
        onTeam: function () { p.team = nextTeam(p.team); save("zing.players", players); show(screenPlayers()); },
        onRemove: function () { players.splice(i, 1); save("zing.players", players); show(screenPlayers()); }
      }));
    });
    s.appendChild(list);
    s.appendChild(btn("＋ Add a player", function () { show(screenAddPlayer(function (p) { players.push(p); save("zing.players", players); show(screenPlayers()); }, function () { show(screenPlayers()); })); }, "", { disabled: players.length >= 8 ? "true" : null }));
    s.appendChild(toggleRow("Play in teams", "Tap a player's badge to pick their team.", gameOpts.teams, function (v) { gameOpts.teams = v; if (v) autoTeams(players); save("zing.players", players); save("zing.gameOpts", gameOpts); show(screenPlayers()); }));
    s.appendChild(el("div", { class: "grow" }));
    var ok = players.length >= 2 && teamsValid(players);
    if (players.length >= 2 && !ok) s.appendChild(el("p", { class: "muted small center", text: "Every player needs a team, and you need at least two teams." }));
    s.appendChild(btn("Next  ›", function () { show(screenSetup()); }, "primary", { disabled: ok ? null : "true" }));
    return s;
  }

  function screenAddPlayer(onAdd, onBack, taken) {
    taken = taken || players;
    var draft = { name: "", avatar: AVATARS.filter(function (a) { return !taken.some(function (p) { return p.avatar === a; }); })[0] || "🙂", band: "adult", team: null };
    var s = el("section", { class: "screen", "aria-label": "Add a player" });
    s.appendChild(topbar(btn("‹ Back", onBack, "ghost slim"), "New player"));
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
      onAdd({ id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: draft.name, avatar: draft.avatar, band: draft.band, team: null });
    }, "primary", { disabled: "true" });
    s.appendChild(addBtn);
    setTimeout(function () { try { input.focus(); } catch (e) {} }, 50);
    return s;
  }

  function optionSegs(container, onChange) {
    container.appendChild(seg("How to play", gameOpts.mode, [{ label: "Turn by turn", value: "shared", sub: "Same question for all, reveal together" }, { label: "Classic", value: "classic", sub: "Own question, instant answer" }], function (v) { gameOpts.mode = v; save("zing.gameOpts", gameOpts); onChange(); }));
    container.appendChild(seg("Game length", gameOpts.length, [{ label: "Quick", value: 5, sub: "5 rounds" }, { label: "Normal", value: 8, sub: "8 rounds" }, { label: "Long", value: 12, sub: "12 rounds" }], function (v) { gameOpts.length = v; save("zing.gameOpts", gameOpts); onChange(); }));
    container.appendChild(seg("Timer", gameOpts.timer, [{ label: "Relaxed", value: 0, sub: "No timer" }, { label: "Gentle", value: 25, sub: "25 seconds" }, { label: "Speedy", value: 12, sub: "12 seconds" }], function (v) { gameOpts.timer = v; save("zing.gameOpts", gameOpts); onChange(); }));
  }

  function screenSetup() {
    var s = el("section", { class: "screen", "aria-label": "Game setup" });
    s.appendChild(topbar(btn("‹ Players", function () { show(screenPlayers()); }, "ghost slim"), "Game setup"));
    optionSegs(s, function () { show(screenSetup()); });
    var strip = el("div", { class: "score-strip" });
    players.forEach(function (p) { strip.appendChild(el("span", { class: "chip" }, [el("span", { class: "avatar", text: p.avatar }), p.name + (gameOpts.teams && teamOf(p.team) ? " " + teamOf(p.team).emoji : "")])); });
    s.appendChild(el("div", { class: "setting" }, [el("span", { class: "label", text: "Playing" }), strip]));
    s.appendChild(el("div", { class: "grow" }));
    s.appendChild(btn("Start game  ⚡", function () {
      if (gameOpts.mode === "classic") startClassic();
      else startSharedLocal();
    }, "primary"));
    return s;
  }

  /* ---------------- Shared scoreboard rendering ---------------- */
  function scoreboardEl(list, teamsOn, animate) {
    var board = el("div", { class: "board" });
    if (teamsOn) {
      var totals = {};
      list.forEach(function (p) { totals[p.team] = (totals[p.team] || 0) + p.score; });
      var teams = TEAMS.filter(function (t) { return totals[t.id] !== undefined; }).sort(function (a, b) { return totals[b.id] - totals[a.id]; });
      var max = Math.max(1, totals[teams[0].id]);
      teams.forEach(function (t, i) {
        var row = el("div", { class: "bar-row" + (i === 0 && totals[t.id] > 0 ? " leader" : "") });
        row.appendChild(el("div", { class: "avatar", text: t.emoji }));
        var fill = el("div", { class: "fill" }); fill.style.background = t.colour;
        fill.style.width = animate ? "6%" : Math.max(6, 100 * totals[t.id] / max) + "%";
        var members = list.filter(function (p) { return p.team === t.id; }).map(function (p) { return p.avatar; }).join(" ");
        row.appendChild(el("div", { class: "track" }, [fill, el("span", { class: "nm", text: t.name + " " + members })]));
        row.appendChild(el("div", { class: "pts", text: String(totals[t.id]) }));
        board.appendChild(row);
        if (animate) setTimeout(function () { fill.style.width = Math.max(6, 100 * totals[t.id] / max) + "%"; }, 80);
      });
      var strip = el("div", { class: "score-strip" });
      list.slice().sort(function (a, b) { return b.score - a.score; }).forEach(function (p) { strip.appendChild(el("span", { class: "chip" }, [el("span", { class: "avatar", text: p.avatar }), p.name + " " + p.score])); });
      board.appendChild(strip);
      return board;
    }
    var sorted = list.slice().sort(function (a, b) { return b.score - a.score; });
    var mx = Math.max(1, sorted[0].score);
    sorted.forEach(function (p, i) {
      var row = el("div", { class: "bar-row" + (i === 0 && p.score > 0 ? " leader" : "") });
      row.appendChild(avatarEl(p));
      var fill = el("div", { class: "fill" });
      fill.style.width = animate ? "6%" : Math.max(6, 100 * p.score / mx) + "%";
      row.appendChild(el("div", { class: "track" }, [fill, el("span", { class: "nm", text: p.name })]));
      row.appendChild(el("div", { class: "pts", text: String(p.score) }));
      board.appendChild(row);
      if (animate) setTimeout(function () { fill.style.width = Math.max(6, 100 * p.score / mx) + "%"; }, 80);
    });
    return board;
  }

  function finalScreen(list, teamsOn, onAgain, onHome) {
    var s = el("section", { class: "screen", "aria-label": "Final results" });
    s.appendChild(topbar(null, "Final results"));
    s.appendChild(el("div", { class: "crown center", "aria-hidden": "true", text: "👑" }));
    if (teamsOn) {
      var totals = {}; list.forEach(function (p) { totals[p.team] = (totals[p.team] || 0) + p.score; });
      var teams = TEAMS.filter(function (t) { return totals[t.id] !== undefined; }).sort(function (a, b) { return totals[b.id] - totals[a.id]; });
      var tie = teams.length > 1 && totals[teams[0].id] === totals[teams[1].id];
      s.appendChild(el("div", { class: "winner-line", text: tie ? "It's a tie!" : teams[0].name + " team wins! " + teams[0].emoji }));
      s.appendChild(scoreboardEl(list, true, true));
    } else {
      var sorted = list.slice().sort(function (a, b) { return b.score - a.score; });
      var top = sorted[0];
      var tied = sorted.filter(function (p) { return p.score === top.score; });
      s.appendChild(el("div", { class: "winner-line", text: tied.length > 1 ? "It's a tie!" : top.name + " wins!" }));
      var pod = el("div", { class: "podium" });
      var order = [sorted[1], sorted[0], sorted[2]];
      ["p2", "p1", "p3"].forEach(function (cls, i) {
        var p = order[i]; var step = el("div", { class: "step " + cls });
        if (p) { step.appendChild(avatarEl(p)); step.appendChild(el("div", { class: "nm", text: p.name })); step.appendChild(el("div", { class: "block", text: String(p.score) })); }
        else step.appendChild(el("div", { class: "block", style: "visibility:hidden" }));
        pod.appendChild(step);
      });
      s.appendChild(pod);
      if (sorted.length > 3) s.appendChild(scoreboardEl(list, false, false));
    }
    var best = list.slice().sort(function (a, b) { return b.correct - a.correct; })[0];
    s.appendChild(el("p", { class: "muted center", text: "Most right answers: " + best.name + " (" + best.correct + ")" }));
    s.appendChild(el("div", { class: "grow" }));
    var row = el("div", { class: "btn-row" });
    if (onAgain) row.appendChild(btn("Play again", onAgain, "primary"));
    row.appendChild(btn("Home", onHome, "ghost"));
    s.appendChild(row);
    setTimeout(function () { Sounds.fanfare(); Native.haptic("success"); confettiBurst(400); setTimeout(function () { confettiBurst(300); }, 900); }, 300);
    return s;
  }

  /* ---------------- Question screen (shared by all modes) ----------------
     Shows a prepared question for a player, calls onAnswer({choice, correct, elapsed}).
     If reveal is true the answer is highlighted immediately; otherwise the caller decides what to show. */
  function questionScreen(p, q, roundLabel, reveal, onAnswer) {
    var s = el("section", { class: "screen", "aria-label": "Question" });
    s.appendChild(el("div", { class: "q-head" }, [
      el("span", { class: "chip" }, [el("span", { class: "avatar", text: p.avatar }), p.name]),
      el("span", { class: "chip", text: roundLabel })
    ]));
    var timerFill = null;
    if (gameOpts.timer) { timerFill = el("div"); s.appendChild(el("div", { class: "timer", "aria-hidden": "true" }, [timerFill])); }
    var card = el("div", { class: "card q-card" });
    var typeLabel = q.type === "tf" ? "True or false?" : q.type === "emoji" ? "Emoji puzzle" : "Multiple choice";
    card.appendChild(el("div", { class: "q-meta" }, [
      el("span", { class: "cat" }, [el("span", { class: "dot", style: "background:" + (CAT_COLOURS[q.cat] || "#999") }), q.cat]),
      el("span", { class: "cat", text: typeLabel + " · " + (LEVEL_NAMES[q.level] || "") })
    ]));
    if (q.prompt) card.appendChild(el("div", { class: "q-prompt", role: "img", "aria-label": "Emoji clue", text: q.prompt }));
    card.appendChild(el("p", { class: "q-text", text: q.q }));
    var speakText = q.q + (q.type === "tf" ? " True or false?" : ". " + q.options.map(function (o, i) { return LETTERS[i] + ". " + o; }).join(". "));
    var speakBtn = el("button", { class: "speak", type: "button", "aria-label": "Read the question aloud" }, ["🔊 ", "Read it to me"]);
    speakBtn.addEventListener("click", function () { speakRequested = true; Native.speak(speakText); speakRequested = false; });
    card.appendChild(speakBtn);
    s.appendChild(card);
    var answers = el("div", { class: "answers" + (q.type === "tf" ? " two" : ""), role: "group", "aria-label": "Answers" });
    var buttons = q.options.map(function (opt, i) {
      var b = el("button", { class: "ans" + (q.type === "tf" ? (i === 0 ? " true" : " false") : ""), type: "button", "data-k": String(i) });
      if (q.type === "tf") { b.appendChild(el("span", { class: "badge", text: i === 0 ? "✓" : "✗" })); b.appendChild(el("span", { class: "txt", text: opt })); }
      else { b.appendChild(el("span", { class: "badge" }, [LETTERS[i], el("span", { class: "shape", text: SHAPES[i] })])); b.appendChild(el("span", { class: "txt", text: opt })); }
      b.addEventListener("click", function () { answer(i); });
      answers.appendChild(b);
      return b;
    });
    s.appendChild(answers);
    var holder = el("div");
    s.appendChild(holder);
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
      var elapsed = (Date.now() - start) / 1000;
      var correct = i === q.answer;
      if (reveal) {
        buttons.forEach(function (b, k) {
          if (k === q.answer) { b.classList.add("correct"); b.appendChild(el("span", { class: "mark", text: "✓" })); }
          else if (k === i) { b.classList.add("wrong"); b.appendChild(el("span", { class: "mark", text: "✗" })); }
          else b.classList.add("dim");
        });
        if (!correct) card.classList.add("shake");
      } else if (i >= 0) {
        buttons[i].classList.add("picked");
      }
      onAnswer({ choice: i, correct: correct, elapsed: elapsed, timedOut: i === -1, holder: holder, card: card });
    }
  }
  function speedBonus(elapsed) { return gameOpts.timer ? Math.max(0, Math.round(5 * (1 - elapsed / gameOpts.timer))) : 0; }

  /* ================= CLASSIC MODE (one phone, own questions, instant reveal) ================= */
  var G = null;
  function startClassic() {
    G = { players: players.map(function (p) { return Object.assign({}, p, { score: 0, streak: 0, correct: 0, lastCat: null }); }), round: 0, turn: 0, total: gameOpts.length, used: {} };
    show(classicPass());
  }
  function classicPass() {
    var p = G.players[G.turn];
    var s = el("section", { class: "screen", "aria-label": "Pass the phone" });
    s.appendChild(topbar(btn("✕ Quit", function () { show(screenHome()); }, "ghost slim"), "Round " + (G.round + 1) + " of " + G.total));
    s.appendChild(el("div", { class: "grow" }));
    s.appendChild(passHero(p, p.score + " points" + (p.streak >= 2 ? " · 🔥 " + p.streak + " in a row" : "")));
    s.appendChild(el("div", { class: "grow" }));
    s.appendChild(miniStrip(G.players));
    s.appendChild(btn("I'm " + p.name + ". Ready!  ›", function () { Sounds.whoosh(); classicQuestion(); }, "primary"));
    return s;
  }
  function passHero(p, sub) {
    var hero = el("div", { class: "pass-hero" });
    hero.appendChild(el("p", { class: "lead muted", text: "Pass the phone to" }));
    hero.appendChild(avatarEl(p, true));
    hero.appendChild(el("div", { class: "name", text: p.name }));
    if (gameOpts.teams && teamOf(p.team)) hero.appendChild(el("span", { class: "chip", text: teamOf(p.team).emoji + " " + teamOf(p.team).name + " team" }));
    if (sub) hero.appendChild(el("p", { class: "muted", text: sub }));
    return hero;
  }
  function miniStrip(list) {
    var strip = el("div", { class: "score-strip" });
    list.slice().sort(function (a, b) { return b.score - a.score; }).forEach(function (q) { strip.appendChild(el("span", { class: "chip" }, [el("span", { class: "avatar", text: q.avatar }), String(q.score)])); });
    return strip;
  }
  function classicQuestion() {
    var p = G.players[G.turn];
    var q = prepareQuestion(pickQuestion(p, G.used, p.lastCat));
    G.used[q.id] = true; seen[q.id] = true; save("zing.seen", seen); p.lastCat = q.cat;
    questionScreen(p, q, "R" + (G.round + 1) + "/" + G.total + " · " + p.score + " pts", true, function (r) {
      var pts = 0, bonus = 0, streakBonus = 0;
      if (r.correct) { pts = 10; bonus = speedBonus(r.elapsed); p.streak += 1; p.correct += 1; if (p.streak >= 3) streakBonus = 5; p.score += pts + bonus + streakBonus; }
      else p.streak = 0;
      if (r.correct) { Sounds.correct(); Native.haptic("success"); confettiBurst(p.streak >= 3 ? 220 : 120); if (streakBonus) setTimeout(Sounds.streak, 500); }
      else { if (r.timedOut) Sounds.timeUp(); else Sounds.wrong(); Native.haptic("error"); }
      var res = el("div", { class: "card result pop " + (r.correct ? "good" : "bad") });
      var verdicts = r.correct ? ["Correct!", "Yes!", "Nailed it!", "Spot on!", "Brilliant!", "You got it!"] : r.timedOut ? ["Out of time!"] : ["Not this time", "Oops!", "So close", "Nope!"];
      res.appendChild(el("div", { class: "verdict", text: verdicts[Math.floor(Math.random() * verdicts.length)] }));
      if (r.correct) { var line = "+" + pts + " points"; if (bonus) line += " · +" + bonus + " speed"; if (streakBonus) line += " · 🔥 +" + streakBonus + " streak"; res.appendChild(el("div", { class: "points", text: line })); }
      else res.appendChild(el("div", { class: "points", text: "The answer was: " + q.options[q.answer] }));
      if (q.fact) res.appendChild(el("p", { class: "fact", text: q.fact }));
      var nextBtn = btn("Next  ›", function () { classicNext(); }, "primary");
      res.appendChild(nextBtn);
      r.holder.appendChild(res);
      setTimeout(function () { try { nextBtn.scrollIntoView({ behavior: settings.motion === "reduce" ? "auto" : "smooth", block: "end" }); } catch (e) {} }, 60);
    });
  }
  function classicNext() {
    G.turn += 1;
    if (G.turn >= G.players.length) {
      G.turn = 0; G.round += 1;
      if (G.round >= G.total) { show(finalScreen(G.players, gameOpts.teams, startClassic, function () { show(screenHome()); })); return; }
      var s = el("section", { class: "screen", "aria-label": "Scores" });
      s.appendChild(topbar(null, "Scores after round " + G.round));
      s.appendChild(scoreboardEl(G.players, gameOpts.teams, true));
      s.appendChild(el("div", { class: "grow" }));
      s.appendChild(el("p", { class: "muted center", text: (G.total - G.round) + (G.total - G.round === 1 ? " round" : " rounds") + " to go" }));
      s.appendChild(btn("Keep going  ›", function () { show(classicPass()); }, "primary"));
      show(s); return;
    }
    show(classicPass());
  }

  /* ================= HOST / CLIENT ENGINE (turn by turn, one phone or linked phones) ================= */
  var Transport = {
    mode: "local",            // "local" (host and client in this page) or "mp" (Multipeer)
    isHost: true,
    hostPeer: null,           // peer id of the host when we are a joiner
    toClients: function (msg) {
      if (Transport.mode === "local") { setTimeout(function () { Client.receive(msg); }, 0); return; }
      Net.send(null, msg);
      setTimeout(function () { Client.receive(msg); }, 0);   // the host phone is a client too
    },
    toHost: function (msg) {
      if (Transport.mode === "local" || Transport.isHost) { setTimeout(function () { Host.receive(Client.me, msg); }, 0); return; }
      Net.send(Transport.hostPeer, msg);
    }
  };

  var Host = {
    S: null,
    init: function (opts) {
      Host.S = { players: {}, order: [], options: opts, round: 0, total: opts.length, used: {}, roundData: null, pending: {}, results: {}, timeout: null, devices: {} };
    },
    setPlayers: function (deviceId, deviceName, list) {
      var S = Host.S; if (!S) return;
      S.devices[deviceId] = deviceName || deviceId;
      S.order = S.order.filter(function (id) { return S.players[id].deviceId !== deviceId; });
      Object.keys(S.players).forEach(function (id) { if (S.players[id].deviceId === deviceId) delete S.players[id]; });
      list.forEach(function (p) {
        S.players[p.id] = Object.assign({}, p, { deviceId: deviceId, score: 0, streak: 0, correct: 0 });
        S.order.push(p.id);
      });
    },
    removeDevice: function (deviceId) { Host.setPlayers(deviceId, null, []); delete Host.S.devices[deviceId]; delete Host.S.pending[deviceId]; if (Host.S.roundData && !Object.keys(Host.S.pending).length) Host.finishRound(); },
    playerList: function () { var S = Host.S; return S.order.map(function (id) { return S.players[id]; }); },
    lobby: function () { Transport.toClients({ t: "lobby", players: Host.playerList(), devices: Host.S.devices, options: Host.S.options }); },
    start: function () {
      var S = Host.S;
      S.round = 0;
      Transport.toClients({ t: "start", players: Host.playerList(), options: S.options, total: S.total });
      setTimeout(Host.startRound, 400);
    },
    startRound: function () {
      var S = Host.S; S.round += 1;
      var list = Host.playerList();
      var byBand = {}, byLevel = {};
      list.forEach(function (p) { if (!byBand[p.band]) byBand[p.band] = pickLevel(p.band); });
      Object.keys(byBand).forEach(function (b) {
        var lv = byBand[b];
        if (!byLevel[lv]) { var q = pickQuestionAtLevel(lv, S.used, null); S.used[q.id] = true; seen[q.id] = true; byLevel[lv] = prepareQuestion(q); }
      });
      save("zing.seen", seen);
      S.pending = {}; S.results = {};
      list.forEach(function (p) { S.pending[p.deviceId] = true; });
      S.roundData = { n: S.round, total: S.total, byBand: byBand, byLevel: byLevel };
      Transport.toClients(Object.assign({ t: "round" }, S.roundData));
      clearTimeout(S.timeout);
      S.timeout = setTimeout(Host.finishRound, 240000);   // nobody waits forever for a phone that wandered off
    },
    onAnswers: function (deviceId, msg) {
      var S = Host.S; if (!S.roundData || msg.round !== S.round) return;
      Object.keys(msg.results).forEach(function (pid) { S.results[pid] = msg.results[pid]; });
      delete S.pending[deviceId];
      Transport.toClients({ t: "progress", done: Object.keys(S.devices).filter(function (d) { return !S.pending[d]; }), waiting: Object.keys(S.pending) });
      if (!Object.keys(S.pending).length) Host.finishRound();
    },
    finishRound: function () {
      var S = Host.S; if (!S.roundData) return;
      clearTimeout(S.timeout);
      var out = {};
      Host.playerList().forEach(function (p) {
        var r = S.results[p.id] || { correct: false, choice: -1, pts: 0 };
        var streakBonus = 0;
        if (r.correct) { p.streak += 1; p.correct += 1; if (p.streak >= 3) streakBonus = 5; p.score += r.pts + streakBonus; } else p.streak = 0;
        out[p.id] = { correct: !!r.correct, choice: r.choice, pts: r.correct ? r.pts + streakBonus : 0, streak: p.streak };
      });
      var data = { t: "reveal", n: S.round, total: S.total, byBand: S.roundData.byBand, byLevel: S.roundData.byLevel, results: out, players: Host.playerList(), last: S.round >= S.total };
      S.roundData = null; S.pending = {};
      Transport.toClients(data);
    },
    next: function () { if (Host.S.round >= Host.S.total) Transport.toClients({ t: "final", players: Host.playerList() }); else Host.startRound(); },
    receive: function (from, msg) {
      if (!Host.S) return;
      if (msg.t === "players") { Host.setPlayers(from, msg.deviceName, msg.players); Host.lobby(); }
      else if (msg.t === "answers") Host.onAnswers(from, msg);
    }
  };

  var Client = {
    me: "local", meName: "This phone", state: null,
    reset: function () { Client.state = { players: [], options: null, total: 0, round: null, queue: [], results: {}, lobby: null }; },
    localPlayers: function () { return Client.state.players.filter(function (p) { return p.deviceId === Client.me; }); },
    receive: function (msg) {
      var st = Client.state; if (!st) return;
      if (msg.t === "lobby") { st.lobby = msg; if (Client.onLobby) Client.onLobby(msg); }
      else if (msg.t === "start") { st.players = msg.players; st.options = msg.options; st.total = msg.total; gameOpts.length = msg.options.length; gameOpts.timer = msg.options.timer; gameOpts.teams = msg.options.teams; show(waitingScreen("Get ready…", "Round 1 is coming.")); }
      else if (msg.t === "round") { st.round = msg; st.results = {}; st.queue = Client.localPlayers().slice(); Client.nextTurn(); }
      else if (msg.t === "progress") { if (Client.onProgress) Client.onProgress(msg); }
      else if (msg.t === "reveal") { st.players = msg.players; show(revealScreen(msg)); }
      else if (msg.t === "final") { st.players = msg.players; show(finalScreen(msg.players, gameOpts.teams, Transport.isHost && Transport.mode === "local" ? startSharedLocal : null, function () { show(screenHome()); })); }
      else if (msg.t === "abort") { show(noticeScreen("Game over", msg.reason || "The host ended the game.")); }
    },
    nextTurn: function () {
      var st = Client.state;
      if (!st.queue.length) {
        Transport.toHost({ t: "answers", round: st.round.n, results: st.results });
        show(waitingScreen("Answers locked in 🔒", Transport.mode === "mp" ? "Waiting for the other phones…" : "Revealing…"));
        return;
      }
      var p = st.queue.shift();
      var s = el("section", { class: "screen", "aria-label": "Pass the phone" });
      s.appendChild(topbar(btn("✕ Quit", function () { quitShared(); }, "ghost slim"), "Round " + st.round.n + " of " + st.round.total));
      s.appendChild(el("div", { class: "grow" }));
      s.appendChild(passHero(p, p.score + " points" + (p.streak >= 2 ? " · 🔥 " + p.streak + " in a row" : "")));
      s.appendChild(el("div", { class: "grow" }));
      s.appendChild(el("p", { class: "muted center small", text: "Nobody else look! The answer is revealed at the end of the round." }));
      s.appendChild(btn("I'm " + p.name + ". Ready!  ›", function () { Sounds.whoosh(); Client.askQuestion(p); }, "primary"));
      show(s);
    },
    askQuestion: function (p) {
      var st = Client.state;
      var q = st.round.byLevel[st.round.byBand[p.band]];
      questionScreen(p, q, "R" + st.round.n + "/" + st.round.total + " · " + p.score + " pts", false, function (r) {
        st.results[p.id] = { correct: r.correct, choice: r.choice, pts: r.correct ? 10 + speedBonus(r.elapsed) : 0 };
        Sounds.whoosh(); Native.haptic("medium");
        var res = el("div", { class: "card result pop" });
        res.appendChild(el("div", { class: "verdict", text: r.timedOut ? "Out of time!" : "Locked in 🔒" }));
        res.appendChild(el("p", { class: "fact center", text: st.queue.length ? "Pass the phone to " + st.queue[0].name + "." : "The answer is revealed when everyone has played." }));
        var nextBtn = btn(st.queue.length ? "Next player  ›" : "Lock in  ›", function () { Client.nextTurn(); }, "primary");
        res.appendChild(nextBtn);
        r.holder.appendChild(res);
        setTimeout(function () { try { nextBtn.scrollIntoView({ behavior: settings.motion === "reduce" ? "auto" : "smooth", block: "end" }); } catch (e) {} }, 60);
      });
    },
    onLobby: null, onProgress: null
  };

  function quitShared() { Net.stop(); Host.S = null; Client.state = null; show(screenHome()); }

  function waitingScreen(title, sub) {
    var s = el("section", { class: "screen center", "aria-label": title });
    s.appendChild(topbar(btn("✕ Quit", function () { quitShared(); }, "ghost slim"), ""));
    s.appendChild(el("div", { class: "grow" }));
    s.appendChild(el("div", { class: "wait-spinner", "aria-hidden": "true", text: "⚡" }));
    s.appendChild(el("h2", { text: title }));
    s.appendChild(el("p", { class: "muted lead", text: sub }));
    var prog = el("div", { class: "score-strip" });
    s.appendChild(prog);
    Client.onProgress = function (msg) {
      prog.innerHTML = "";
      var st = Client.state; var devs = (st.lobby && st.lobby.devices) || {};
      (msg.done || []).forEach(function (d) { prog.appendChild(el("span", { class: "chip", text: "✓ " + (d === Client.me ? "This phone" : peerLabel(devs[d] || d)) })); });
      (msg.waiting || []).forEach(function (d) { prog.appendChild(el("span", { class: "chip", style: "opacity:.6", text: "… " + (d === Client.me ? "This phone" : peerLabel(devs[d] || d)) })); });
    };
    s.appendChild(el("div", { class: "grow" }));
    return s;
  }
  function noticeScreen(title, sub) {
    var s = el("section", { class: "screen center", "aria-label": title });
    s.appendChild(el("div", { class: "grow" }));
    s.appendChild(el("h2", { text: title }));
    s.appendChild(el("p", { class: "muted lead", text: sub }));
    s.appendChild(el("div", { class: "grow" }));
    s.appendChild(btn("Home", function () { quitShared(); }, "primary"));
    return s;
  }

  function revealScreen(msg) {
    var st = Client.state;
    var s = el("section", { class: "screen", "aria-label": "Round reveal" });
    s.appendChild(topbar(null, "Round " + msg.n + " of " + msg.total));
    var localIds = {}; Client.localPlayers().forEach(function (p) { localIds[p.id] = true; });
    var anyLocalRight = false, anyLocal = false;
    var levels = Object.keys(msg.byLevel).map(Number).sort();
    levels.forEach(function (lv) {
      var q = msg.byLevel[lv];
      var card = el("div", { class: "card q-card reveal" });
      card.appendChild(el("div", { class: "q-meta" }, [el("span", { class: "cat" }, [el("span", { class: "dot", style: "background:" + (CAT_COLOURS[q.cat] || "#999") }), q.cat]), el("span", { class: "cat", text: LEVEL_NAMES[lv] + " question" })]));
      if (q.prompt) card.appendChild(el("div", { class: "q-prompt small-prompt", text: q.prompt }));
      card.appendChild(el("p", { class: "q-text", text: q.q }));
      card.appendChild(el("div", { class: "reveal-answer", text: "✓ " + q.options[q.answer] }));
      if (q.fact) card.appendChild(el("p", { class: "fact", text: q.fact }));
      var who = el("div", { class: "who" });
      msg.players.filter(function (p) { return msg.byBand[p.band] === lv; }).forEach(function (p) {
        var r = msg.results[p.id] || { correct: false, pts: 0 };
        if (localIds[p.id]) { anyLocal = true; if (r.correct) anyLocalRight = true; }
        var chip = el("span", { class: "chip who-chip " + (r.correct ? "right" : "wrong") }, [el("span", { class: "avatar", text: p.avatar }), p.name + " " + (r.correct ? "✓ +" + r.pts : "✗")]);
        if (r.correct && r.choice >= 0 && r.streak >= 3) chip.appendChild(el("span", { text: " 🔥" }));
        who.appendChild(chip);
      });
      card.appendChild(who);
      s.appendChild(card);
    });
    s.appendChild(el("h3", { class: "center", text: gameOpts.teams ? "Team scores" : "Scores" }));
    s.appendChild(scoreboardEl(msg.players, gameOpts.teams, true));
    s.appendChild(el("div", { class: "grow" }));
    if (Transport.isHost) s.appendChild(btn(msg.last ? "See the final results  ›" : "Next round  ›", function () { Host.next(); }, "primary"));
    else s.appendChild(el("p", { class: "muted center", text: msg.last ? "Waiting for the host to show the final results…" : "Waiting for the host to start the next round…" }));
    setTimeout(function () {
      if (!anyLocal) return;
      if (anyLocalRight) { Sounds.correct(); Native.haptic("success"); confettiBurst(160); } else { Sounds.wrong(); Native.haptic("error"); }
    }, 250);
    return s;
  }

  // Turn-by-turn on a single phone: host and client in the same page.
  function startSharedLocal() {
    Transport.mode = "local"; Transport.isHost = true; Transport.hostPeer = null;
    Client.me = "local"; Client.meName = "This phone"; Client.reset();
    Host.init({ length: gameOpts.length, timer: gameOpts.timer, teams: gameOpts.teams });
    Host.setPlayers("local", "This phone", players);
    Host.start();
  }

  /* ================= LINK PHONES (Multipeer) ================= */
  var linkName = load("zing.phoneName", "");
  function defaultPhoneName() { return linkName || (players[0] ? players[0].name + "'s phone" : "My phone"); }

  function screenLink() {
    var s = el("section", { class: "screen", "aria-label": "Link phones" });
    s.appendChild(topbar(btn("‹ Home", function () { show(screenHome()); }, "ghost slim"), "Link phones"));
    var card = el("div", { class: "card" });
    card.appendChild(el("h3", { text: "Play on several phones at once" }));
    card.appendChild(el("p", { html: "One phone <b>hosts</b> the game. Everyone else <b>joins</b> it. Phones talk over Bluetooth and Wi‑Fi, so no internet is needed. Each phone adds its own players, everyone answers the same questions at the same time, and the scores sync after every round." }));
    s.appendChild(card);
    if (!Net.available()) {
      s.appendChild(el("p", { class: "muted center", text: "Linking phones needs the Zing app on iPhone. In this preview you can still play turn by turn on one phone." }));
      s.appendChild(btn("Play on this phone instead", function () { show(screenPlayers()); }, "primary"));
      return s;
    }
    var input = el("input", { type: "text", id: "phone-name", placeholder: "Name this phone", maxlength: "18", autocomplete: "off", value: defaultPhoneName(), "aria-label": "Name this phone" });
    input.addEventListener("input", function () { linkName = input.value.trim(); save("zing.phoneName", linkName); });
    s.appendChild(el("div", { class: "setting" }, [el("span", { class: "label", text: "This phone's name" }), input]));
    s.appendChild(el("div", { class: "grow" }));
    var name = function () { return input.value.trim() || defaultPhoneName(); };
    s.appendChild(btn("👑  Host a game", function () { startHosting(name()); }, "primary"));
    s.appendChild(btn("📲  Join a game", function () { startJoining(name()); }, ""));
    return s;
  }

  function startHosting(name) {
    Transport.mode = "mp"; Transport.isHost = true; Transport.hostPeer = null;
    Client.reset(); Client.meName = name;
    Host.init({ length: gameOpts.length, timer: gameOpts.timer, teams: gameOpts.teams });
    Net.onEvent = function (ev) {
      if (ev.kind === "ready") { Client.me = ev.me; Host.setPlayers(Client.me, name, players); Host.lobby(); show(hostLobby()); }
      if (ev.kind === "peers") {
        var known = {}; (ev.peers || []).forEach(function (p) { known[p.id] = true; });
        if (Host.S) Object.keys(Host.S.devices).forEach(function (d) { if (d !== Client.me && !known[d]) { Host.removeDevice(d); Host.lobby(); } });
        if (Host.S && !Host.S.roundData && currentScreen === "hostLobby") show(hostLobby());
      }
      if (ev.kind === "message") { try { Host.receive(ev.from, JSON.parse(ev.payload)); } catch (e) { console.error(e); } }
      if (ev.kind === "error") toast(ev.message || "Connection problem");
    };
    Net.host(name);
    show(waitingScreen("Starting…", "Switching on Bluetooth and Wi‑Fi."));
  }
  var currentScreen = "";
  function hostLobby() {
    currentScreen = "hostLobby";
    var S = Host.S;
    var s = el("section", { class: "screen", "aria-label": "Host lobby" });
    s.appendChild(topbar(btn("✕ Cancel", function () { quitShared(); }, "ghost slim"), "Hosting: " + Client.meName));
    var phones = Net.peers.length;
    s.appendChild(el("div", { class: "card" }, [el("h3", { text: phones ? phones + (phones === 1 ? " phone joined" : " phones joined") : "Waiting for phones to join…" }), el("p", { class: "muted", text: "On the other phones tap Link phones, then Join a game, then pick \"" + Client.meName + "\"." })]));
    var list = el("div", { class: "player-list" });
    var all = Host.playerList();
    all.forEach(function (p) {
      var mine = p.deviceId === Client.me;
      list.appendChild(playerRow(p, {
        device: mine ? "this phone" : peerLabel(S.devices[p.deviceId] || ""),
        teams: S.options.teams,
        onTeam: function () { p.team = nextTeam(p.team); if (mine) { var lp = players.filter(function (x) { return x.id === p.id; })[0]; if (lp) { lp.team = p.team; save("zing.players", players); } } Host.lobby(); show(hostLobby()); },
        onRemove: mine ? function () { players = players.filter(function (x) { return x.id !== p.id; }); save("zing.players", players); Host.setPlayers(Client.me, Client.meName, players); Host.lobby(); show(hostLobby()); } : null
      }));
    });
    s.appendChild(list);
    s.appendChild(btn("＋ Add a player on this phone", function () { show(screenAddPlayer(function (p) { players.push(p); save("zing.players", players); Host.setPlayers(Client.me, Client.meName, players); Host.lobby(); show(hostLobby()); }, function () { show(hostLobby()); }, all)); }, ""));
    s.appendChild(toggleRow("Play in teams", "Tap a badge to change a player's team.", S.options.teams, function (v) { S.options.teams = v; gameOpts.teams = v; save("zing.gameOpts", gameOpts); if (v) { autoTeams(all); autoTeams(players); save("zing.players", players); } Host.lobby(); show(hostLobby()); }));
    var optsWrap = el("div", { class: "stack" });
    optsWrap.appendChild(seg("Game length", S.options.length, [{ label: "Quick", value: 5, sub: "5 rounds" }, { label: "Normal", value: 8, sub: "8 rounds" }, { label: "Long", value: 12, sub: "12 rounds" }], function (v) { S.options.length = v; S.total = v; gameOpts.length = v; save("zing.gameOpts", gameOpts); Host.lobby(); show(hostLobby()); }));
    optsWrap.appendChild(seg("Timer", S.options.timer, [{ label: "Relaxed", value: 0, sub: "No timer" }, { label: "Gentle", value: 25, sub: "25 seconds" }, { label: "Speedy", value: 12, sub: "12 seconds" }], function (v) { S.options.timer = v; gameOpts.timer = v; save("zing.gameOpts", gameOpts); Host.lobby(); show(hostLobby()); }));
    s.appendChild(optsWrap);
    var ok = all.length >= 2 && (!S.options.teams || (all.every(function (p) { return !!p.team; }) && Object.keys(all.reduce(function (m, p) { m[p.team] = 1; return m; }, {})).length >= 2));
    s.appendChild(btn("Start game  ⚡", function () { currentScreen = ""; gameOpts.length = S.options.length; gameOpts.timer = S.options.timer; gameOpts.teams = S.options.teams; Host.start(); }, "primary", { disabled: ok ? null : "true" }));
    return s;
  }

  function startJoining(name) {
    Transport.mode = "mp"; Transport.isHost = false; Transport.hostPeer = null;
    Client.reset(); Client.meName = name;
    var joined = false;
    Net.onEvent = function (ev) {
      if (ev.kind === "ready") { Client.me = ev.me; show(joinList()); }
      if (ev.kind === "found" && !joined) show(joinList());
      if (ev.kind === "peers") {
        var connected = (ev.peers || []).filter(function (p) { return p.state === "connected"; });
        if (!joined && connected.length) { joined = true; Transport.hostPeer = connected[0].id; Transport.toHost({ t: "players", deviceName: name, players: players }); show(clientLobby()); }
        else if (joined && !connected.length) { show(noticeScreen("Connection lost", "The host phone went out of range or ended the game.")); }
      }
      if (ev.kind === "message") { try { Client.receive(JSON.parse(ev.payload)); } catch (e) { console.error(e); } }
      if (ev.kind === "error") toast(ev.message || "Connection problem");
    };
    Net.join(name);
    show(waitingScreen("Looking for a host…", "Make sure the host phone has tapped Host a game."));
  }
  function joinList() {
    var s = el("section", { class: "screen", "aria-label": "Join a game" });
    s.appendChild(topbar(btn("✕ Cancel", function () { quitShared(); }, "ghost slim"), "Join a game"));
    s.appendChild(el("p", { class: "muted center", text: Net.hosts.length ? "Tap the phone that is hosting." : "Looking for phones hosting a game nearby…" }));
    var list = el("div", { class: "stack" });
    Net.hosts.forEach(function (h) { list.appendChild(btn("📡  " + peerLabel(h.name || h.id), function () { Net.invite(h.id); show(waitingScreen("Joining " + peerLabel(h.name || h.id) + "…", "Hang on a second.")); }, "")); });
    s.appendChild(list);
    s.appendChild(el("div", { class: "grow" }));
    s.appendChild(el("div", { class: "wait-spinner center", "aria-hidden": "true", text: "📡" }));
    return s;
  }
  function clientLobby() {
    currentScreen = "clientLobby";
    var s = el("section", { class: "screen", "aria-label": "Lobby" });
    s.appendChild(topbar(btn("✕ Leave", function () { quitShared(); }, "ghost slim"), "Joined"));
    var lobby = Client.state.lobby;
    s.appendChild(el("div", { class: "card" }, [el("h3", { text: "Players on this phone" }), el("p", { class: "muted", text: "Add everyone who will answer on this phone. The host starts the game." })]));
    var list = el("div", { class: "player-list" });
    players.forEach(function (p, i) {
      var hp = lobby && lobby.players.filter(function (x) { return x.id === p.id; })[0];
      if (hp) p.team = hp.team;
      list.appendChild(playerRow(p, { teams: !!(lobby && lobby.options && lobby.options.teams), onRemove: function () { players.splice(i, 1); save("zing.players", players); Transport.toHost({ t: "players", deviceName: Client.meName, players: players }); show(clientLobby()); } }));
    });
    s.appendChild(list);
    s.appendChild(btn("＋ Add a player on this phone", function () { show(screenAddPlayer(function (p) { players.push(p); save("zing.players", players); Transport.toHost({ t: "players", deviceName: Client.meName, players: players }); show(clientLobby()); }, function () { show(clientLobby()); }, lobby ? lobby.players : players)); }, ""));
    if (lobby) {
      var others = lobby.players.filter(function (p) { return p.deviceId !== Client.me; });
      if (others.length) {
        s.appendChild(el("span", { class: "label", text: "Everyone else" }));
        var strip = el("div", { class: "score-strip" });
        others.forEach(function (p) { strip.appendChild(el("span", { class: "chip" }, [el("span", { class: "avatar", text: p.avatar }), p.name + (lobby.options.teams && teamOf(p.team) ? " " + teamOf(p.team).emoji : "")])); });
        s.appendChild(strip);
      }
    }
    s.appendChild(el("div", { class: "grow" }));
    s.appendChild(el("p", { class: "muted center", text: "Waiting for the host to start…" }));
    Client.onLobby = function () { if (currentScreen === "clientLobby") show(clientLobby()); };
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
  window.ZING = { pool: POOL, pick: pickQuestion, pickAtLevel: pickQuestionAtLevel, bands: BANDS, players: function () { return players; }, host: Host, client: Client, transport: Transport };
  show(screenHome());
})();
