/* Zing sound engine — everything synthesised with WebAudio, no audio files.
   Right/wrong noises are picked at random from a set so they stay funny. */
(function () {
  var ctx = null;
  var enabled = true;
  var master = null;

  function ensure() {
    if (!enabled) return null;
    try {
      if (!ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0.9;
        master.connect(ctx.destination);
      }
      if (ctx.state === "suspended") ctx.resume();
      return ctx;
    } catch (e) { return null; }
  }

  function now() { return ctx.currentTime; }

  // A single tone with an amplitude envelope and optional pitch glide.
  function tone(opts) {
    var c = ensure(); if (!c) return;
    var o = c.createOscillator();
    var g = c.createGain();
    var t0 = now() + (opts.at || 0);
    var dur = opts.dur || 0.2;
    o.type = opts.type || "sine";
    o.frequency.setValueAtTime(opts.freq, t0);
    if (opts.to) o.frequency.exponentialRampToValueAtTime(Math.max(20, opts.to), t0 + dur);
    if (opts.vib) {
      var lfo = c.createOscillator(); var lg = c.createGain();
      lfo.frequency.value = opts.vib; lg.gain.value = opts.vibDepth || 8;
      lfo.connect(lg); lg.connect(o.frequency); lfo.start(t0); lfo.stop(t0 + dur + 0.05);
    }
    var vol = opts.vol || 0.25;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + (opts.attack || 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    var dest = master;
    if (opts.filter) {
      var f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = opts.filter; f.Q.value = 2;
      o.connect(f); f.connect(g);
    } else { o.connect(g); }
    g.connect(dest);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }

  // Filtered noise burst (cheers, splats, raspberries).
  function noise(opts) {
    var c = ensure(); if (!c) return;
    var t0 = now() + (opts.at || 0);
    var dur = opts.dur || 0.3;
    var buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    var src = c.createBufferSource(); src.buffer = buf;
    var f = c.createBiquadFilter(); f.type = opts.type || "bandpass";
    f.frequency.setValueAtTime(opts.freq || 1000, t0);
    if (opts.to) f.frequency.exponentialRampToValueAtTime(opts.to, t0 + dur);
    f.Q.value = opts.q || 1;
    var g = c.createGain();
    var vol = opts.vol || 0.2;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + (opts.attack || 0.02));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t0); src.stop(t0 + dur + 0.05);
  }

  /* ---------- Correct-answer noises ---------- */
  var good = {
    tada: function () {
      tone({ freq: 523, dur: 0.18, type: "triangle", vol: 0.3 });
      tone({ freq: 659, dur: 0.18, type: "triangle", vol: 0.3, at: 0.12 });
      tone({ freq: 784, dur: 0.45, type: "triangle", vol: 0.35, at: 0.24 });
      tone({ freq: 1046, dur: 0.6, type: "sine", vol: 0.25, at: 0.24 });
      noise({ freq: 3000, dur: 0.5, vol: 0.05, at: 0.26, type: "highpass" });
    },
    sparkle: function () {
      var notes = [660, 880, 1100, 1320, 1760, 2200];
      for (var i = 0; i < notes.length; i++) tone({ freq: notes[i], dur: 0.14, type: "sine", vol: 0.22, at: i * 0.05 });
      tone({ freq: 2640, dur: 0.5, type: "sine", vol: 0.12, at: 0.3 });
    },
    boing: function () {
      tone({ freq: 180, to: 900, dur: 0.22, type: "sine", vol: 0.35 });
      tone({ freq: 240, to: 1100, dur: 0.22, type: "sine", vol: 0.3, at: 0.22 });
      tone({ freq: 300, to: 1400, dur: 0.3, type: "sine", vol: 0.3, at: 0.44 });
    },
    dingding: function () {
      for (var i = 0; i < 3; i++) {
        tone({ freq: 1568, dur: 0.25, type: "sine", vol: 0.3, at: i * 0.16 });
        tone({ freq: 3136, dur: 0.2, type: "sine", vol: 0.1, at: i * 0.16 });
      }
    },
    cheer: function () {
      noise({ freq: 900, to: 1800, dur: 0.9, vol: 0.22, q: 0.6, attack: 0.15 });
      noise({ freq: 400, to: 700, dur: 0.9, vol: 0.14, q: 0.8, attack: 0.1 });
      tone({ freq: 523, dur: 0.5, type: "triangle", vol: 0.18, at: 0.1 });
      tone({ freq: 784, dur: 0.6, type: "triangle", vol: 0.18, at: 0.25 });
    },
    laser: function () {
      tone({ freq: 2400, to: 300, dur: 0.18, type: "square", vol: 0.12, filter: 2500 });
      tone({ freq: 2400, to: 300, dur: 0.18, type: "square", vol: 0.12, filter: 2500, at: 0.12 });
      tone({ freq: 1200, dur: 0.4, type: "triangle", vol: 0.25, at: 0.26 });
    }
  };

  /* ---------- Wrong-answer noises ---------- */
  var bad = {
    sadTrombone: function () {
      var seq = [[311, 0], [294, 0.33], [277, 0.66], [262, 1.0]];
      for (var i = 0; i < seq.length; i++) {
        var last = i === seq.length - 1;
        tone({ freq: seq[i][0] * 1.02, to: seq[i][0] * (last ? 0.9 : 0.98), dur: last ? 0.9 : 0.32, type: "sawtooth", vol: 0.16, at: seq[i][1], filter: 900, vib: last ? 6 : 0, vibDepth: 10 });
      }
    },
    buzzer: function () {
      tone({ freq: 110, dur: 0.45, type: "square", vol: 0.14, filter: 600 });
      tone({ freq: 112, dur: 0.45, type: "sawtooth", vol: 0.1, filter: 600 });
    },
    wahwah: function () {
      tone({ freq: 520, to: 180, dur: 0.5, type: "sawtooth", vol: 0.16, filter: 1200, vib: 9, vibDepth: 25 });
      tone({ freq: 400, to: 120, dur: 0.6, type: "sawtooth", vol: 0.12, filter: 800, at: 0.45, vib: 7, vibDepth: 20 });
    },
    splat: function () {
      noise({ freq: 600, to: 120, dur: 0.35, vol: 0.35, q: 1.2, type: "lowpass", attack: 0.005 });
      tone({ freq: 160, to: 60, dur: 0.3, type: "sine", vol: 0.3 });
    },
    raspberry: function () {
      noise({ freq: 220, to: 150, dur: 0.55, vol: 0.3, q: 4, type: "bandpass", attack: 0.02 });
      tone({ freq: 95, to: 70, dur: 0.55, type: "sawtooth", vol: 0.1, filter: 300, vib: 28, vibDepth: 30 });
    },
    womp: function () {
      tone({ freq: 220, to: 110, dur: 0.35, type: "triangle", vol: 0.28 });
      tone({ freq: 196, to: 90, dur: 0.6, type: "triangle", vol: 0.28, at: 0.38 });
    },
    duck: function () {
      for (var i = 0; i < 3; i++) tone({ freq: 480, to: 320, dur: 0.14, type: "sawtooth", vol: 0.14, filter: 1500, at: i * 0.17 });
    }
  };

  function pick(obj) { var k = Object.keys(obj); return obj[k[Math.floor(Math.random() * k.length)]]; }

  var Sounds = {
    setEnabled: function (v) { enabled = !!v; if (enabled) ensure(); },
    unlock: function () { ensure(); },
    tap: function () { tone({ freq: 700, dur: 0.06, type: "sine", vol: 0.12 }); },
    whoosh: function () { noise({ freq: 400, to: 2500, dur: 0.3, vol: 0.12, q: 0.7 }); },
    tick: function () { tone({ freq: 1200, dur: 0.04, type: "square", vol: 0.05 }); },
    timeUp: function () { tone({ freq: 440, dur: 0.15, type: "square", vol: 0.12 }); tone({ freq: 440, dur: 0.15, type: "square", vol: 0.12, at: 0.2 }); tone({ freq: 330, dur: 0.4, type: "square", vol: 0.12, at: 0.4 }); },
    correct: function () { pick(good)(); },
    wrong: function () { pick(bad)(); },
    streak: function () { good.sparkle(); tone({ freq: 1568, dur: 0.5, type: "triangle", vol: 0.2, at: 0.35 }); },
    fanfare: function () {
      var seq = [[523, 0], [523, 0.15], [523, 0.3], [659, 0.45], [784, 0.75], [659, 0.95], [784, 1.1]];
      for (var i = 0; i < seq.length; i++) tone({ freq: seq[i][0], dur: i === seq.length - 1 ? 1.2 : 0.22, type: "triangle", vol: 0.3, at: seq[i][1] });
      noise({ freq: 1000, to: 2000, dur: 1.6, vol: 0.18, q: 0.6, attack: 0.3, at: 0.6 });
    },
    drumroll: function () { for (var i = 0; i < 16; i++) noise({ freq: 250, dur: 0.07, vol: 0.18, q: 1.5, type: "lowpass", at: i * 0.07 }); }
  };
  window.Sounds = Sounds;
})();
