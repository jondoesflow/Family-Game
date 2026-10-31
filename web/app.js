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

  /* ---------------- Small JSON fetch: browser fetch first, native bridge as fallback ---------------- */
  var HTTP = {
    pending: {}, n: 0,
    json: function (url) {
      return new Promise(function (resolve, reject) {
        var viaNative = function () {
          if (!Native.has()) { reject(new Error("offline")); return; }
          var id = "h" + (++HTTP.n);
          HTTP.pending[id] = { resolve: resolve, reject: reject };
          Native.post({ type: "http", id: id, url: url });
          setTimeout(function () { if (HTTP.pending[id]) { delete HTTP.pending[id]; reject(new Error("timeout")); } }, 8000);
        };
        try { fetch(url).then(function (r) { return r.json(); }).then(resolve).catch(viaNative); } catch (e) { viaNative(); }
      });
    },
    _done: function (msg) { var p = HTTP.pending[msg.id]; if (!p) return; delete HTTP.pending[msg.id]; try { p.resolve(JSON.parse(msg.body)); } catch (e) { p.reject(e); } }
  };
  window.ZingHTTP = HTTP;

  /* ---------------- Music clip player (always plays, regardless of the sound-effects setting) ---------------- */
  var Clip = {
    el: document.getElementById("clip"), onProgress: null, onEnd: null, onError: null, src: null,
    play: function (url) {
      var a = Clip.el; if (!a) return;
      Clip.src = url;
      try { a.pause(); a.src = url; a.currentTime = 0; a.volume = 1; var pr = a.play(); if (pr && pr.catch) pr.catch(function () { if (Clip.onError) Clip.onError("blocked"); }); } catch (e) { if (Clip.onError) Clip.onError(String(e)); }
    },
    toggle: function () { var a = Clip.el; if (!a) return; if (a.paused) { if (a.src) a.play().catch(function () {}); } else a.pause(); },
    stop: function () { var a = Clip.el; if (!a) return; try { a.pause(); a.removeAttribute("src"); a.load(); } catch (e) {} Clip.onProgress = null; Clip.onEnd = null; Clip.onError = null; Clip.src = null; }
  };
  if (Clip.el) {
    Clip.el.addEventListener("timeupdate", function () { if (Clip.onProgress && Clip.el.duration) Clip.onProgress(Clip.el.currentTime / Clip.el.duration, Clip.el.paused); });
    Clip.el.addEventListener("play", function () { if (Clip.onProgress) Clip.onProgress(Clip.el.duration ? Clip.el.currentTime / Clip.el.duration : 0, false); });
    Clip.el.addEventListener("pause", function () { if (Clip.onProgress) Clip.onProgress(Clip.el.duration ? Clip.el.currentTime / Clip.el.duration : 0, true); });
    Clip.el.addEventListener("ended", function () { if (Clip.onEnd) Clip.onEnd(); });
    Clip.el.addEventListener("error", function () { musicTrouble = Date.now(); if (Clip.onError) Clip.onError("error"); });
  }
  var musicTrouble = 0;
  function musicAvailable() { return (window.CONTENT_MUSIC && window.CONTENT_MUSIC.tracks && window.CONTENT_MUSIC.tracks.length > 0) && navigator.onLine !== false && (Date.now() - musicTrouble > 120000); }
  // If a stored preview link has gone stale, ask iTunes for a fresh one by track id.
  function refreshPreview(item) {
    return HTTP.json("https://itunes.apple.com/lookup?id=" + encodeURIComponent(item.trackId) + "&country=GB").then(function (d) {
      var r = (d.results || []).filter(function (x) { return x.previewUrl; })[0];
      if (!r) throw new Error("no preview");
      item.preview = r.previewUrl; return r.previewUrl;
    });
  }
  function peerLabel(id) { return String(id || "").replace(/#[A-Za-z0-9]+$/, ""); }

  /* ---------------- Storage ---------------- */
  function load(key, fallback) { try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } }
  function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }

  var settings = Object.assign({ size: "normal", font: "clear", motion: "full", sounds: true, readAloud: false }, load("zing.settings", {}));
  var players = load("zing.players", []);
  var seen = load("zing.seen", {});
  var gameOpts = Object.assign({ length: 8, timer: 0, mode: "shared", teams: false, cats: null }, load("zing.gameOpts", {}));
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

  // Category groups the host can pick from. A question belongs to every group it matches.
  var GROUPS = [
    { id: "general", name: "General knowledge", ic: "🧠", cats: ["General Knowledge", "Everyday Life", "Words", "Numbers", "Maths", "Mathematics", "Silly", "Jobs", "Languages", "Inventions", "Human Body"] },
    { id: "science", name: "Science & nature", ic: "🔬", cats: ["Science", "Science & Nature", "Nature", "Space", "Animals", "Dinosaurs", "Oceans", "Weather", "Technology", "Computers", "Gadgets"] },
    { id: "geo", name: "Geography & travel", ic: "🌍", cats: ["Geography", "Flags", "Places", "Famous Landmarks", "Transport", "Vehicles", "UK"] },
    { id: "history", name: "History", ic: "📜", cats: ["History", "Mythology"] },
    { id: "screen", name: "Film, TV & books", ic: "🎬", cats: ["Films", "Film", "Television", "TV", "Cartoons", "Heroes", "Stories", "Books", "Comics", "Theatre", "Rhymes", "Art"] },
    { id: "music", name: "Music", ic: "🎵", cats: ["Music"], types: ["music"] },
    { id: "sport", name: "Sport & games", ic: "⚽", cats: ["Sport", "Sports", "Board Games", "Video Games"] },
    { id: "food", name: "Food & drink", ic: "🍕", cats: ["Food"] },
    { id: "faces", name: "Famous faces", ic: "📸", types: ["face"] },
    { id: "dingbats", name: "Dingbats", ic: "🧩", types: ["dingbat"] },
    { id: "xmas", name: "Christmas", ic: "🎄", cats: ["Christmas"], optIn: true },
    { id: "friends", name: "Friends: the TV show (hard)", ic: "☕", cats: ["Friends"], optIn: true, adultsOnly: true },
    { id: "e1960", name: "1960s", ic: "🕰", era: 1960 }, { id: "e1970", name: "1970s", ic: "🕰", era: 1970 }, { id: "e1980", name: "1980s", ic: "🕰", era: 1980 }, { id: "e1990", name: "1990s", ic: "🕰", era: 1990 },
    { id: "e2000", name: "2000s", ic: "🕰", era: 2000 }, { id: "e2010", name: "2010s", ic: "🕰", era: 2010 }, { id: "e2020", name: "2020s", ic: "🕰", era: 2020 }
  ];
  var CAT_TO_GROUP = {};
  GROUPS.forEach(function (g) { (g.cats || []).forEach(function (c) { CAT_TO_GROUP[c] = g.id; }); });
  function defaultGroups() { return GROUPS.filter(function (g) { return !g.optIn; }).map(function (g) { return g.id; }); }
  function eraOf(q) {
    if (q.era) return q.era;
    if (q.decade) return q.decade;
    var m = /\b(19[6-9]\d|20[0-2]\d)\b/.exec(q.q || "");
    return m ? Math.floor(parseInt(m[1], 10) / 10) * 10 : null;
  }
  function tagGroups(q) {
    var gs = [];
    if (q.type !== "music" && q.type !== "face" && q.type !== "dingbat") gs.push(CAT_TO_GROUP[q.cat] || "general");
    var primary = GROUPS.filter(function (g) { return g.id === gs[0]; })[0];
    if (primary && primary.adultsOnly) q.adultsOnly = true;
    if (primary && primary.optIn) { q.groups = gs; return q; }   // opt-in rounds (Christmas, Friends) never leak into other groups
    GROUPS.forEach(function (g) { if (g.types && g.types.indexOf(q.type) >= 0 && gs.indexOf(g.id) < 0) gs.push(g.id); });
    var era = eraOf(q);
    if (era) { var eg = "e" + era; if (GROUPS.some(function (g) { return g.id === eg; }) && gs.indexOf(eg) < 0) gs.push(eg); }
    q.groups = gs;
    return q;
  }

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
    var M = window.CONTENT_MUSIC || {};
    (M.tracks || []).forEach(function (t) { pool.push(Object.assign({ type: "music", q: "" }, t)); });
    var XM = window.CONTENT_XMAS || {};
    (XM.quiz || []).forEach(function (q) { pool.push(Object.assign({ type: "mc" }, q)); });
    (XM.tf || []).forEach(function (q) { pool.push(Object.assign({ type: "tf" }, q)); });
    var E = window.CONTENT_ERAS || {};
    (E.quiz || []).forEach(function (q) { pool.push(Object.assign({ type: "mc" }, q)); });
    var D = window.CONTENT_DINGBATS || {};
    (D.items || []).forEach(function (d) { pool.push(Object.assign({ type: "dingbat", cat: "Dingbats", q: "What does this say?" }, d)); });
    var FRQ = window.CONTENT_FRIENDS || {};
    (FRQ.quiz || []).forEach(function (q) { pool.push(Object.assign({ type: "mc" }, q)); });
    var F = window.CONTENT_FACES || {};
    (F.faces || []).forEach(function (f) { pool.push(Object.assign({ type: "face", cat: "Famous Faces", q: "" }, f)); });
    pool.forEach(tagGroups);
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
  var selectedGroups = null;   // set for the current game (host side); null means the saved/default choice
  function currentGroups() { return selectedGroups || gameOpts.cats || defaultGroups(); }
  function activePool(band) {
    var gs = currentGroups(); var music = musicAvailable(); var adult = band === "adult" || !band;
    var pool = POOL.filter(function (q) { if (q.type === "music" && !music) return false; if (q.adultsOnly && !adult) return false; return q.groups.some(function (g) { return gs.indexOf(g) >= 0; }); });
    if (!pool.length) pool = POOL.filter(function (q) { return (q.type !== "music" || music) && !(q.adultsOnly && !adult); });
    return pool;
  }
  var TYPE_WEIGHTS = { mc: 0.40, emoji: 0.18, tf: 0.12, music: 0.14, face: 0.10, dingbat: 0.06 };
  function pickQuestionAtLevel(level, usedIds, lastCat, band) {
    var pool = activePool(band);
    var present = {}; pool.forEach(function (q) { present[q.type] = true; });
    var weights = {}; Object.keys(TYPE_WEIGHTS).forEach(function (t) { if (present[t]) weights[t] = TYPE_WEIGHTS[t]; });
    var type = weightedPick(weights);
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
      var cands = pool.filter(attempts[i]);
      if (cands.length) {
        if (i >= 4) { seen = {}; save("zing.seen", seen); }
        return cands[Math.floor(Math.random() * cands.length)];
      }
    }
    return pool[0] || POOL[0];
  }
  function pickQuestion(player, usedIds, lastCat) { return pickQuestionAtLevel(pickLevel(player.band), usedIds, lastCat, player.band); }

  // A question prepared for play: options shuffled, correct index recomputed. Safe to send to other phones.
  function prepareQuestion(q) {
    if (q.type === "music") return prepareMusic(q);
    if (q.type === "face") return prepareFace(q);
    if (q.type === "dingbat") return prepareDingbat(q);
    var out = { id: q.id, type: q.type, level: q.level, cat: q.cat, q: q.q, prompt: q.prompt || null, fact: q.fact || null };
    if (q.type === "tf") { out.options = ["True", "False"]; out.answer = q.answer ? 0 : 1; }
    else { var idx = shuffle([0, 1, 2, 3]); out.options = idx.map(function (i) { return q.options[i]; }); out.answer = idx.indexOf(q.answer); }
    return out;
  }

  // A music track becomes one of three questions: name the song, name the artist, or pick the year.
  function prepareMusic(t) {
    var tracks = (window.CONTENT_MUSIC && window.CONTENT_MUSIC.tracks) || [];
    var form = weightedPick({ title: 0.4, artist: 0.35, year: 0.25 });
    var out = { id: t.id, type: "music", level: t.level, cat: "Music", form: form, prompt: null, preview: t.preview, trackId: t.trackId, artist: t.artist, title: t.title, year: t.year, fact: t.artist + " \u2013 " + t.title + " (" + t.year + ")" };
    function others(field) {
      var same = tracks.filter(function (x) { return x.id !== t.id && x[field] !== t[field] && Math.abs(x.decade - t.decade) <= 10; });
      if (same.length < 3) same = tracks.filter(function (x) { return x.id !== t.id && x[field] !== t[field]; });
      var seenV = {}; seenV[t[field]] = true; var picks = [];
      shuffle(same.slice()).forEach(function (x) { if (picks.length < 3 && !seenV[x[field]]) { seenV[x[field]] = true; picks.push(x[field]); } });
      return picks;
    }
    if (form === "title") { out.q = "Name this song."; var o1 = shuffle([t.title].concat(others("title"))); out.options = o1; out.answer = o1.indexOf(t.title); }
    else if (form === "artist") { out.q = "Who is this by?"; var o2 = shuffle([t.artist].concat(others("artist"))); out.options = o2; out.answer = o2.indexOf(t.artist); }
    else {
      out.q = "Which year was this released?";
      var offs = shuffle([-7, -5, -3, -2, 2, 3, 5, 7]).slice(0, 3);
      var years = [t.year].concat(offs.map(function (o) { return t.year + o; })).sort(function (a, b) { return a - b; });
      out.options = years.map(String); out.answer = years.indexOf(t.year); out.keepOrder = true;
    }
    return out;
  }

  function prepareDingbat(d) {
    var idx = shuffle([0, 1, 2, 3]);
    return { id: d.id, type: "dingbat", level: d.level, cat: "Dingbats", q: "What does this say?", prompt: null, spec: { layout: d.layout, items: d.items }, options: idx.map(function (i) { return d.options[i]; }), answer: idx.indexOf(d.answer), fact: "It says: " + d.options[d.answer] };
  }
  // A famous face becomes "Who is this?" (blurred, sharpening over time) or a two-face mash-up.
  function prepareFace(f) {
    var faces = (window.CONTENT_FACES && window.CONTENT_FACES.faces) || [];
    var others = shuffle(faces.filter(function (x) { return x.id !== f.id; }).slice());
    var near = others.filter(function (x) { return Math.abs(x.level - f.level) <= 1; });
    if (near.length < 4) near = others;
    var mash = faces.length >= 6 && Math.random() < 0.3;
    if (!mash) {
      var o = shuffle([f.name].concat(near.slice(0, 3).map(function (x) { return x.name; })));
      return { id: f.id, type: "face", form: "who", level: f.level, cat: "Famous Faces", q: "Who is this?", prompt: null, img: f.img, credit: f.credit, options: o, answer: o.indexOf(f.name), fact: f.name };
    }
    var b = near[0], c = near[1], d = near[2];
    var pair = function (x, y) { return x.name + " & " + y.name; };
    var o2 = shuffle([pair(f, b), pair(f, c), pair(d, b), pair(d, c)]);
    return { id: f.id, type: "face", form: "mash", level: Math.max(f.level, b.level), cat: "Famous Faces", q: "Which two famous faces are mashed together?", prompt: null, img: f.img, imgB: b.img, credit: f.credit, creditB: b.credit, options: o2, answer: o2.indexOf(pair(f, b)), fact: f.name + " (left) and " + b.name + " (right)" };
  }
  function creditLine(c) { return c ? "Photo: " + c.artist + " · " + c.licence + " · Wikimedia Commons" : ""; }

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
  function show(screenEl) { Native.stopSpeaking(); Clip.stop(); app.innerHTML = ""; app.appendChild(screenEl); app.scrollTop = 0; }
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
  function renderDingbat(spec) {
    var root = el("div", { class: "dingbat", role: "img", "aria-label": "Dingbat puzzle" });
    function item(it) {
      var cls = "it" + (it.small ? " small" : "") + (it.mirror ? " mirror" : "") + (it.flip ? " flip" : "") + (it.box ? " box" : "") + (it.strike ? " strike" : "") + (it.under ? " under" : "") + (it.gap ? " gap" : "") + (it.align === "left" ? " left" : "");
      var e = el("span", { class: cls });
      e.appendChild(document.createTextNode(it.t));
      if (it.sup) e.appendChild(el("sup", { text: it.sup }));
      if (it.size) e.style.fontSize = it.size + "em";
      if (it.colour) e.style.color = it.colour;
      if (it.rot) e.style.transform = "translate(-50%, -50%) rotate(" + it.rot + "deg)";
      return e;
    }
    if (spec.layout === "stack") {
      var st = el("div", { class: "stack" });
      spec.items.forEach(function (it) { if (it.rule) st.appendChild(el("div", { class: "rule" })); st.appendChild(item(it)); if (it.rule) st.appendChild(el("div", { class: "rule" })); });
      root.appendChild(st);
    } else if (spec.layout === "cross") {
      var cr = el("div", { class: "cross" }); spec.items.forEach(function (it) { cr.appendChild(item(it)); }); root.appendChild(cr);
    } else {
      var row = el("div", { class: "row" }); spec.items.forEach(function (it) { row.appendChild(item(it)); }); root.appendChild(row);
    }
    return root;
  }
  function renderFace(q, reveal) {
    var wrap = el("div", { class: "face-wrap" + (q.form === "who" && !reveal ? " blur" : ""), role: "img", "aria-label": q.form === "mash" ? "Two famous faces mashed together" : "A famous face" });
    wrap.appendChild(el("img", { src: q.img, alt: "" }));
    if (q.form === "mash") { wrap.appendChild(el("img", { src: q.imgB, alt: "", class: "half-b" })); wrap.appendChild(el("div", { class: "seam" })); }
    if (q.form === "who" && !reveal) setTimeout(function () { wrap.classList.add("go"); }, 400);
    return wrap;
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
    stack.appendChild(el("p", { class: "muted small", text: "One player or a whole family." }));
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
      el("li", { text: "On your own? Add just one player for solo mode: straight through the questions, chasing your best score." }),
      el("li", { text: "Turn by turn: everyone in the same age group gets the same question each round. Answers lock in, then the round is revealed together." }),
      el("li", { text: "Classic: each player gets their own question and sees the answer straight away." }),
      el("li", { text: "Teams: tap the badge next to a player to put them in Red, Blue, Green or Yellow. Team scores add up." }),
      el("li", { text: "Link phones: one phone hosts, the others join over Bluetooth. Each phone holds its own players and everyone answers at the same time." }),
      el("li", { text: "Categories: the host picks one or many. Topics, famous faces, dingbats, a Christmas round, a hard Friends round (grown-ups only), and eras from the 1960s to the 2020s." }),
      el("li", { text: "Music rounds: a 30 second clip plays. Name the song, the artist or the year. Needs internet." }),
      el("li", { text: "Famous faces: a photo sharpens slowly, or two faces are mashed together. Dingbats: say what the picture-word puzzle means." }),
      el("li", { text: "10 points for a right answer, plus a speed bonus with the timer on, plus 5 for three in a row. On linked phones it is fastest finger first: 15, 12, 10, then 8 points." })
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
    s.appendChild(toggleRow("Sound effects", "Cheers, boings, drumrolls and sad trombones. Music clips in music questions always play.", settings.sounds, function (v) { settings.sounds = v; applySettings(); }));
    s.appendChild(toggleRow("Read questions aloud", "Every question is spoken automatically.", settings.readAloud, function (v) { settings.readAloud = v; applySettings(); }));
    s.appendChild(btn("Test a noise 🔊", function () { Math.random() < 0.5 ? Sounds.correct() : Sounds.wrong(); }, "ghost"));
    s.appendChild(btn("Forget which questions I've seen", function () { seen = {}; save("zing.seen", seen); toast("Question history cleared"); }, "ghost"));
    s.appendChild(btn("Photo credits", function () { show(screenCredits()); }, "ghost"));
    s.appendChild(el("p", { class: "muted small center", text: "Zing Quiz · " + POOL.length.toLocaleString("en-GB") + " questions · made for families" }));
    s.appendChild(el("p", { class: "muted small center", text: "Includes questions from the Open Trivia Database (opentdb.com), CC BY-SA 4.0." }));
    return s;
  }

  function screenCredits() {
    var s = el("section", { class: "screen", "aria-label": "Photo credits" });
    s.appendChild(topbar(btn("‹ Back", function () { show(screenSettings()); }, "ghost slim"), "Photo credits"));
    s.appendChild(el("p", { class: "muted small", text: "Famous-face photos come from Wikimedia Commons under free licences. Thank you to the photographers." }));
    var faces = (window.CONTENT_FACES && window.CONTENT_FACES.faces) || [];
    var list = el("div", { class: "stack" });
    faces.forEach(function (f) { list.appendChild(el("p", { class: "credit light", text: f.name + ": " + f.credit.artist + " · " + f.credit.licence })); });
    if (!faces.length) list.appendChild(el("p", { class: "muted", text: "No photos bundled." }));
    s.appendChild(list);
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
    if (!players.length) list.appendChild(el("p", { class: "muted center", text: "Add the first player to start. One is fine: that is solo mode." }));
    players.forEach(function (p, i) {
      list.appendChild(playerRow(p, {
        teams: gameOpts.teams,
        onTeam: function () { p.team = nextTeam(p.team); save("zing.players", players); show(screenPlayers()); },
        onRemove: function () { players.splice(i, 1); save("zing.players", players); show(screenPlayers()); }
      }));
    });
    s.appendChild(list);
    s.appendChild(btn("＋ Add a player", function () { show(screenAddPlayer(function (p) { players.push(p); save("zing.players", players); show(screenPlayers()); }, function () { show(screenPlayers()); })); }, "", { disabled: players.length >= 8 ? "true" : null }));
    if (players.length >= 2) s.appendChild(toggleRow("Play in teams", "Tap a player's badge to pick their team.", gameOpts.teams, function (v) { gameOpts.teams = v; if (v) autoTeams(players); save("zing.players", players); save("zing.gameOpts", gameOpts); show(screenPlayers()); }));
    else if (players.length === 1) s.appendChild(el("p", { class: "muted small center", text: "Solo mode: " + players[0].name + " plays straight through and tries to beat their best score." }));
    s.appendChild(el("div", { class: "grow" }));
    var solo = players.length === 1;
    var ok = players.length >= 1 && (solo || teamsValid(players));
    if (players.length >= 2 && !ok) s.appendChild(el("p", { class: "muted small center", text: "Every player needs a team, and you need at least two teams." }));
    s.appendChild(btn(solo ? "Play solo  ›" : "Next  ›", function () { show(screenSetup()); }, "primary", { disabled: ok ? null : "true" }));
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

  function isSolo() { return players.length === 1; }
  function optionSegs(container, onChange) {
    if (!isSolo()) container.appendChild(seg("How to play", gameOpts.mode, [{ label: "Turn by turn", value: "shared", sub: "Same question for all, reveal together" }, { label: "Classic", value: "classic", sub: "Own question, instant answer" }], function (v) { gameOpts.mode = v; save("zing.gameOpts", gameOpts); onChange(); }));
    container.appendChild(seg("Game length", gameOpts.length, [{ label: "Quick", value: 5, sub: "5 rounds" }, { label: "Normal", value: 8, sub: "8 rounds" }, { label: "Long", value: 12, sub: "12 rounds" }], function (v) { gameOpts.length = v; save("zing.gameOpts", gameOpts); onChange(); }));
    container.appendChild(seg("Timer", gameOpts.timer, [{ label: "Relaxed", value: 0, sub: "No timer" }, { label: "Gentle", value: 25, sub: "25 seconds" }, { label: "Speedy", value: 12, sub: "12 seconds" }], function (v) { gameOpts.timer = v; save("zing.gameOpts", gameOpts); onChange(); }));
  }

  function groupCounts() {
    var counts = {}; var music = musicAvailable();
    POOL.forEach(function (q) { if (q.type === "music" && !music) return; q.groups.forEach(function (g) { counts[g] = (counts[g] || 0) + 1; }); });
    return counts;
  }
  function catsSummary(cats) {
    var sel = cats || defaultGroups();
    var all = defaultGroups();
    if (sel.length === all.length && all.every(function (g) { return sel.indexOf(g) >= 0; })) return "All categories";
    if (sel.length <= 3) return sel.map(function (id) { var g = GROUPS.filter(function (x) { return x.id === id; })[0]; return g ? g.ic + " " + g.name : id; }).join(", ");
    return sel.length + " categories chosen";
  }
  function screenCategories(current, onDone) {
    var sel = (current || defaultGroups()).slice();
    var counts = groupCounts();
    var s = el("section", { class: "screen", "aria-label": "Categories" });
    s.appendChild(topbar(btn("‹ Back", function () { onDone(sel); }, "ghost slim"), "Categories"));
    s.appendChild(el("p", { class: "muted small", text: "Pick one or many. Questions come from every category you tick." }));
    var row = el("div", { class: "btn-row" });
    row.appendChild(btn("All", function () { sel = defaultGroups(); show(screenCategories(sel, onDone)); }, "ghost slim"));
    row.appendChild(btn("Clear", function () { sel = []; show(screenCategories(sel, onDone)); }, "ghost slim"));
    s.appendChild(row);
    function chip(g) {
      var on = sel.indexOf(g.id) >= 0;
      var b = el("button", { class: "cat-chip", type: "button", "aria-pressed": String(on) });
      b.appendChild(el("span", { class: "ic", text: g.ic }));
      b.appendChild(el("span", { class: "n" }, [g.name, el("span", { class: "count", text: counts[g.id] ? " · " + counts[g.id] : " · none yet" })]));
      b.addEventListener("click", function () { Sounds.unlock(); Sounds.tap(); Native.haptic("light"); if (on) sel = sel.filter(function (x) { return x !== g.id; }); else sel.push(g.id); show(screenCategories(sel, onDone)); });
      if (!counts[g.id]) b.disabled = true;
      return b;
    }
    var topics = el("div", { class: "cat-grid" });
    GROUPS.filter(function (g) { return !g.era; }).forEach(function (g) { topics.appendChild(chip(g)); });
    s.appendChild(el("div", { class: "setting" }, [el("span", { class: "label", text: "Topics" }), topics]));
    var eras = el("div", { class: "cat-grid cat-eras" });
    GROUPS.filter(function (g) { return g.era; }).forEach(function (g) { eras.appendChild(chip(g)); });
    s.appendChild(el("div", { class: "setting" }, [el("span", { class: "label", text: "Eras (news, events and music by decade)" }), eras]));
    s.appendChild(el("div", { class: "grow" }));
    s.appendChild(btn(sel.length ? "Done  ›" : "Pick at least one", function () { onDone(sel); }, "primary", { disabled: sel.length ? null : "true" }));
    return s;
  }
  function categoryRow(cats, onPick) {
    var wrap = el("div", { class: "setting" });
    wrap.appendChild(el("span", { class: "label", text: "Categories" }));
    wrap.appendChild(btn("🗂  " + catsSummary(cats) + "  ›", onPick, ""));
    return wrap;
  }

  function screenSetup() {
    var s = el("section", { class: "screen", "aria-label": "Game setup" });
    s.appendChild(topbar(btn("‹ Players", function () { show(screenPlayers()); }, "ghost slim"), isSolo() ? "Solo game" : "Game setup"));
    if (isSolo()) { var best = (load("zing.best", {}))[gameOpts.length]; s.appendChild(el("div", { class: "card" }, [el("h3", { text: players[0].avatar + " " + players[0].name + " vs the quiz" }), el("p", { class: "muted", text: best ? "Best score for " + gameOpts.length + " rounds: " + best + " points." : "No best score yet for " + gameOpts.length + " rounds. Set one!" })])); }
    s.appendChild(categoryRow(gameOpts.cats, function () { show(screenCategories(gameOpts.cats, function (sel) { gameOpts.cats = sel; save("zing.gameOpts", gameOpts); show(screenSetup()); })); }));
    optionSegs(s, function () { show(screenSetup()); });
    var strip = el("div", { class: "score-strip" });
    players.forEach(function (p) { strip.appendChild(el("span", { class: "chip" }, [el("span", { class: "avatar", text: p.avatar }), p.name + (gameOpts.teams && teamOf(p.team) ? " " + teamOf(p.team).emoji : "")])); });
    s.appendChild(el("div", { class: "setting" }, [el("span", { class: "label", text: "Playing" }), strip]));
    s.appendChild(el("div", { class: "grow" }));
    s.appendChild(btn("Start game  ⚡", function () {
      selectedGroups = (gameOpts.cats && gameOpts.cats.length) ? gameOpts.cats.slice() : null;
      if (gameOpts.mode === "classic" || isSolo()) startClassic();
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
    var typeLabel = q.type === "tf" ? "True or false?" : q.type === "emoji" ? "Emoji puzzle" : q.type === "music" ? "Music" : q.type === "face" ? "Picture" : q.type === "dingbat" ? "Dingbat" : "Multiple choice";
    card.appendChild(el("div", { class: "q-meta" }, [
      el("span", { class: "cat" }, [el("span", { class: "dot", style: "background:" + (CAT_COLOURS[q.cat] || "#999") }), q.cat]),
      el("span", { class: "cat", text: typeLabel + " · " + (LEVEL_NAMES[q.level] || "") })
    ]));
    if (q.prompt) card.appendChild(el("div", { class: "q-prompt", role: "img", "aria-label": "Emoji clue", text: q.prompt }));
    if (q.type === "dingbat") card.appendChild(renderDingbat(q.spec));
    if (q.type === "face") { card.appendChild(renderFace(q, false)); card.appendChild(el("p", { class: "credit", text: creditLine(q.credit) + (q.creditB ? " · " + creditLine(q.creditB) : "") })); }
    card.appendChild(el("p", { class: "q-text", text: q.q }));
    var skipBtn = null;
    if (q.type === "music") {
      var box = el("div", { class: "music-box" });
      var playBtn = el("button", { class: "play", type: "button", "aria-label": "Play or pause the music clip", text: "▶" });
      var meta = el("div", { class: "meta" }, [el("div", { class: "t", text: "Listen to the clip" }), el("div", { class: "d", text: "30 seconds. Tap to pause or play again." })]);
      var barFill = el("div"); meta.appendChild(el("div", { class: "bar" }, [barFill]));
      box.appendChild(playBtn); box.appendChild(meta);
      card.appendChild(box);
      playBtn.addEventListener("click", function () { Sounds.unlock(); if (Clip.src) Clip.toggle(); else startClip(); });
      Clip.onProgress = function (frac, paused) { barFill.style.width = Math.round(frac * 100) + "%"; box.classList.toggle("playing", !paused); playBtn.textContent = paused ? "▶" : "❚❚"; };
      Clip.onEnd = function () { box.classList.remove("playing"); playBtn.textContent = "↻"; };
      Clip.onError = function () {
        refreshPreview(q).then(function (url) { Clip.onError = function () { clipFailed(); }; Clip.play(url); }).catch(clipFailed);
      };
      var startClip = function () { Clip.play(q.preview); };
      var clipFailed = function () {
        meta.firstChild.textContent = "Couldn't load the music";
        meta.children[1].textContent = "Check the internet connection, or skip this one.";
        if (!skipBtn) { skipBtn = btn("Skip this question", function () { answer(-2); }, "ghost slim"); card.appendChild(skipBtn); }
      };
      setTimeout(startClip, 350);
    }
    var speakText = (q.type === "music" || q.type === "face" || q.type === "dingbat") ? q.q : q.q + (q.type === "tf" ? " True or false?" : ". " + q.options.map(function (o, i) { return LETTERS[i] + ". " + o; }).join(". "));
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
    if (q.type === "music") Sounds.scratch(); else Sounds.pop();
    if (settings.readAloud && q.type !== "music") setTimeout(function () { Native.speak(speakText); }, 350);

    var start = Date.now(), done = false, raf = null, lastTick = -1;
    if (gameOpts.timer) {
      var tick = function () {
        if (done) return;
        var elapsed = (Date.now() - start) / 1000;
        var frac = Math.max(0, 1 - elapsed / gameOpts.timer);
        timerFill.style.transform = "scaleX(" + frac + ")";
        var secLeft = Math.ceil(gameOpts.timer - elapsed);
        if (secLeft <= 5 && secLeft !== lastTick && secLeft > 0) { lastTick = secLeft; if (secLeft <= 3) Sounds.beep(); else Sounds.tick(); }
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
      var skipped = i === -2;
      var fw = card.querySelector(".face-wrap"); if (fw) { fw.classList.remove("blur"); }
      if (reveal && !skipped) {
        buttons.forEach(function (b, k) {
          if (k === q.answer) { b.classList.add("correct"); b.appendChild(el("span", { class: "mark", text: "✓" })); }
          else if (k === i) { b.classList.add("wrong"); b.appendChild(el("span", { class: "mark", text: "✗" })); }
          else b.classList.add("dim");
        });
        if (!correct) card.classList.add("shake");
      } else if (i >= 0) {
        buttons[i].classList.add("picked");
      }
      onAnswer({ choice: i, correct: correct, elapsed: elapsed, timedOut: i === -1, skipped: skipped, holder: holder, card: card });
    }
  }
  function speedBonus(elapsed) { return gameOpts.timer ? Math.max(0, Math.round(5 * (1 - elapsed / gameOpts.timer))) : 0; }

  /* ================= CLASSIC MODE (one phone, own questions, instant reveal) ================= */
  var G = null;
  function startClassic() {
    G = { players: players.map(function (p) { return Object.assign({}, p, { score: 0, streak: 0, correct: 0, lastCat: null }); }), round: 0, turn: 0, total: gameOpts.length, used: {}, solo: players.length === 1 };
    show(classicPass());
  }
  function classicPass() {
    var p = G.players[G.turn];
    var s = el("section", { class: "screen", "aria-label": "Pass the phone" });
    s.appendChild(topbar(btn("✕ Quit", function () { show(screenHome()); }, "ghost slim"), "Round " + (G.round + 1) + " of " + G.total));
    s.appendChild(el("div", { class: "grow" }));
    if (G.solo) { var hero = el("div", { class: "pass-hero" }); hero.appendChild(avatarEl(p, true)); hero.appendChild(el("div", { class: "name", text: p.name })); hero.appendChild(el("p", { class: "muted lead", text: G.total + " questions. 10 points each, bonuses for streaks" + (gameOpts.timer ? " and speed" : "") + "." })); s.appendChild(hero); }
    else s.appendChild(passHero(p, p.score + " points" + (p.streak >= 2 ? " · 🔥 " + p.streak + " in a row" : "")));
    s.appendChild(el("div", { class: "grow" }));
    if (!G.solo) s.appendChild(miniStrip(G.players));
    s.appendChild(btn(G.solo ? "Let's go  ›" : "I'm " + p.name + ". Ready!  ›", function () { Sounds.whoosh(); classicQuestion(); }, "primary"));
    if (G.turn === 0) setTimeout(Sounds.chime, 100);
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
      else if (!r.skipped) p.streak = 0;
      if (r.correct) { Sounds.correct(); Native.haptic("success"); confettiBurst(p.streak >= 3 ? 220 : 120); if (streakBonus) setTimeout(Sounds.streak, 500); }
      else if (r.skipped) { Sounds.whoosh(); }
      else { if (r.timedOut) Sounds.timeUp(); else Sounds.wrong(); Native.haptic("error"); }
      var res = el("div", { class: "card result pop " + (r.correct ? "good" : r.skipped ? "" : "bad") });
      var verdicts = r.correct ? ["Correct!", "Yes!", "Nailed it!", "Spot on!", "Brilliant!", "You got it!"] : r.skipped ? ["Skipped"] : r.timedOut ? ["Out of time!"] : ["Not this time", "Oops!", "So close", "Nope!"];
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
  function soloFinal() {
    var p = G.players[0];
    var bests = load("zing.best", {});
    var prev = bests[G.total] || 0;
    var isBest = bests[G.total] === undefined || p.score > prev;
    if (isBest) { bests[G.total] = p.score; save("zing.best", bests); }
    var s = el("section", { class: "screen center", "aria-label": "Your result" });
    s.appendChild(topbar(null, "Your result"));
    s.appendChild(el("div", { class: "grow" }));
    s.appendChild(el("div", { class: "crown", "aria-hidden": "true", text: isBest ? "🏆" : p.correct >= G.total * 0.7 ? "🌟" : "💪" }));
    s.appendChild(el("div", { class: "winner-line", text: p.score + " points" }));
    s.appendChild(el("p", { class: "lead", text: p.correct + " of " + G.total + " right" }));
    s.appendChild(el("p", { class: "muted", text: isBest ? (prev ? "New best! Your old best was " + prev + "." : "That's your first best score for " + G.total + " rounds.") : "Your best for " + G.total + " rounds is " + prev + "." }));
    s.appendChild(el("div", { class: "grow" }));
    var row = el("div", { class: "btn-row" });
    row.appendChild(btn("Play again", startClassic, "primary"));
    row.appendChild(btn("Home", function () { show(screenHome()); }, "ghost"));
    s.appendChild(row);
    setTimeout(function () { if (isBest) { Sounds.fanfare(); confettiBurst(400); Native.haptic("success"); } else Sounds.chime(); }, 300);
    return s;
  }
  function classicNext() {
    G.turn += 1;
    if (G.turn >= G.players.length) {
      G.turn = 0; G.round += 1;
      if (G.round >= G.total) { show(G.solo ? soloFinal() : finalScreen(G.players, gameOpts.teams, startClassic, function () { show(screenHome()); })); return; }
      if (G.solo) { classicQuestion(); return; }
      var s = el("section", { class: "screen", "aria-label": "Scores" });
      s.appendChild(topbar(null, "Scores after round " + G.round));
      s.appendChild(scoreboardEl(G.players, gameOpts.teams, true));
      setTimeout(Sounds.rise, 150);
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
      S.round = 0; Sounds.chime();
      Transport.toClients({ t: "start", players: Host.playerList(), options: S.options, total: S.total });
      setTimeout(Host.startRound, 400);
    },
    startRound: function () {
      var S = Host.S; S.round += 1;
      var list = Host.playerList();
      var byBand = {}, byLevel = {};
      // Grown-ups pick first so an adults-only question can never be shared down to a younger band at the same level.
      var bandsPresent = []; list.forEach(function (p) { if (bandsPresent.indexOf(p.band) < 0) bandsPresent.push(p.band); });
      bandsPresent.sort(function (a, b) { return (b === "adult") - (a === "adult"); });
      bandsPresent.forEach(function (b) {
        var lv = pickLevel(b);
        if (byLevel[lv] && byLevel[lv].adultsOnly && b !== "adult") lv = Math.min(lv, 2);
        byBand[b] = lv;
        if (!byLevel[lv]) { var q = pickQuestionAtLevel(lv, S.used, null, b); S.used[q.id] = true; seen[q.id] = true; byLevel[lv] = prepareQuestion(q); byLevel[lv].adultsOnly = !!q.adultsOnly; }
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
      var list = Host.playerList();
      var fastest = Transport.mode === "mp";
      if (fastest) {
        // Linked phones: fastest finger first. Rank the right answers to each question by time taken.
        var groups = {};
        list.forEach(function (p) { var lv = S.roundData.byBand[p.band]; (groups[lv] = groups[lv] || []).push(p); });
        Object.keys(groups).forEach(function (lv) {
          groups[lv].filter(function (p) { return S.results[p.id] && S.results[p.id].correct; })
            .sort(function (a, b) { return (S.results[a.id].elapsed || 999) - (S.results[b.id].elapsed || 999); })
            .forEach(function (p, i) { S.results[p.id].pts = [15, 12, 10][i] || 8; S.results[p.id].rank = i + 1; });
        });
      }
      var out = {};
      list.forEach(function (p) {
        var r = S.results[p.id] || { correct: false, choice: -1, pts: 0 };
        var streakBonus = 0;
        if (r.correct) { p.streak += 1; p.correct += 1; if (p.streak >= 3) streakBonus = 5; p.score += r.pts + streakBonus; } else if (!r.skipped) p.streak = 0;
        out[p.id] = { correct: !!r.correct, choice: r.choice, skipped: !!r.skipped, pts: r.correct ? r.pts + streakBonus : 0, streak: p.streak, rank: r.rank || 0, elapsed: r.elapsed || 0 };
      });
      var data = { t: "reveal", n: S.round, total: S.total, byBand: S.roundData.byBand, byLevel: S.roundData.byLevel, results: out, players: Host.playerList(), last: S.round >= S.total, fastest: fastest };
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
      else if (msg.t === "round") { st.round = msg; st.results = {}; st.queue = Client.localPlayers().slice(); Sounds.chime(); Client.nextTurn(); }
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
        st.results[p.id] = { correct: r.correct, choice: r.choice, skipped: r.skipped, elapsed: Math.round(r.elapsed * 100) / 100, pts: r.correct ? 10 + speedBonus(r.elapsed) : 0 };
        Sounds.lock(); Native.haptic("medium");
        var res = el("div", { class: "card result pop" });
        res.appendChild(el("div", { class: "verdict", text: r.timedOut ? "Out of time!" : r.skipped ? "Skipped" : "Locked in 🔒" }));
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
      if (q.type === "dingbat") card.appendChild(renderDingbat(q.spec));
      if (q.type === "face") { card.appendChild(renderFace(q, true)); card.appendChild(el("p", { class: "credit", text: creditLine(q.credit) + (q.creditB ? " · " + creditLine(q.creditB) : "") })); }
      card.appendChild(el("p", { class: "q-text", text: q.q }));
      card.appendChild(el("div", { class: "reveal-answer", text: "✓ " + q.options[q.answer] }));
      if (q.fact) card.appendChild(el("p", { class: "fact", text: q.fact }));
      if (q.type === "music" && q.preview) card.appendChild(btn("▶  Play it again", function () { Clip.onError = null; Clip.play(q.preview); }, "ghost slim"));
      var who = el("div", { class: "who" });
      msg.players.filter(function (p) { return msg.byBand[p.band] === lv; }).forEach(function (p) {
        var r = msg.results[p.id] || { correct: false, pts: 0 };
        if (localIds[p.id]) { anyLocal = true; if (r.correct) anyLocalRight = true; }
        var label = r.correct ? "✓ +" + r.pts : r.skipped ? "skipped" : "✗";
        if (msg.fastest && r.correct) label = (r.rank === 1 ? "⚡ 1st" : r.rank === 2 ? "2nd" : r.rank === 3 ? "3rd" : r.rank + "th") + " · " + r.elapsed.toFixed(1) + "s · +" + r.pts;
        var chip = el("span", { class: "chip who-chip " + (r.correct ? "right" : r.skipped ? "" : "wrong") }, [el("span", { class: "avatar", text: p.avatar }), p.name + " " + label]);
        if (r.correct && r.streak >= 3) chip.appendChild(el("span", { text: " 🔥" }));
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
    Sounds.reveal();
    setTimeout(function () {
      if (!anyLocal) return;
      if (anyLocalRight) { Sounds.correct(); Native.haptic("success"); confettiBurst(160); } else { Sounds.wrong(); Native.haptic("error"); }
      setTimeout(Sounds.rise, 900);
    }, 1500);
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
    Host.init({ length: gameOpts.length, timer: gameOpts.timer, teams: gameOpts.teams, cats: gameOpts.cats });
    Net.onEvent = function (ev) {
      if (ev.kind === "ready") { Client.me = ev.me; Host.setPlayers(Client.me, name, players); Host.lobby(); show(hostLobby()); }
      if (ev.kind === "peers") {
        var known = {}; (ev.peers || []).forEach(function (p) { known[p.id] = true; });
        if (Host.S) { var before = Object.keys(Host.S.devices).length - 1; var now = (ev.peers || []).length; if (now > before) Sounds.connect(); else if (now < before) Sounds.disconnect(); }
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
    optsWrap.appendChild(categoryRow(S.options.cats, function () { currentScreen = ""; show(screenCategories(S.options.cats, function (sel) { S.options.cats = sel; gameOpts.cats = sel; save("zing.gameOpts", gameOpts); Host.lobby(); show(hostLobby()); })); }));
    optsWrap.appendChild(seg("Game length", S.options.length, [{ label: "Quick", value: 5, sub: "5 rounds" }, { label: "Normal", value: 8, sub: "8 rounds" }, { label: "Long", value: 12, sub: "12 rounds" }], function (v) { S.options.length = v; S.total = v; gameOpts.length = v; save("zing.gameOpts", gameOpts); Host.lobby(); show(hostLobby()); }));
    optsWrap.appendChild(seg("Timer", S.options.timer, [{ label: "Relaxed", value: 0, sub: "No timer" }, { label: "Gentle", value: 25, sub: "25 seconds" }, { label: "Speedy", value: 12, sub: "12 seconds" }], function (v) { S.options.timer = v; gameOpts.timer = v; save("zing.gameOpts", gameOpts); Host.lobby(); show(hostLobby()); }));
    s.appendChild(optsWrap);
    var ok = all.length >= 2 && (!S.options.teams || (all.every(function (p) { return !!p.team; }) && Object.keys(all.reduce(function (m, p) { m[p.team] = 1; return m; }, {})).length >= 2));
    s.appendChild(btn("Start game  ⚡", function () { currentScreen = ""; gameOpts.length = S.options.length; gameOpts.timer = S.options.timer; gameOpts.teams = S.options.teams; selectedGroups = (S.options.cats && S.options.cats.length) ? S.options.cats.slice() : null; Host.start(); }, "primary", { disabled: ok ? null : "true" }));
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
        if (!joined && connected.length) { joined = true; Sounds.connect(); Transport.hostPeer = connected[0].id; Transport.toHost({ t: "players", deviceName: name, players: players }); show(clientLobby()); }
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
  window.ZING = { pool: POOL, groups: GROUPS, setGroups: function (g) { selectedGroups = g; }, activePool: activePool, prepare: prepareQuestion, musicAvailable: musicAvailable, pick: pickQuestion, pickAtLevel: pickQuestionAtLevel, bands: BANDS, players: function () { return players; }, host: Host, client: Client, transport: Transport };
  show(screenHome());
})();
