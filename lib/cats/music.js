// ParaFree — Dancing Cats music (lib/cats/music.js). Fetched only after the user clicks 🔊 on the cats.
// Every tune is GENERATED here with WebAudio — no audio files, no recordings. The sound is kept soft and bouncy on
// purpose: a plucked, marimba-like lead (sine + a quiet octave, fast decay), a round "tuba" oom-pah bass and a very
// quiet off-beat tick. The melodies are simplified arrangements of public-domain compositions (all composers died
// before 1920); see music/CREDITS.md. Loops are scheduled ahead on the AudioContext clock, so they repeat seamlessly.
(function () {
  'use strict';
  if (window.PFCatsMusic) return;
  // Each tune: tempo (quarter notes per minute), melody in eighth-note steps ("NOTE:steps", r = rest; total = 4 bars of
  // 8 steps), and one bass root per bar (played "oom-pah": root on beats 1 and 3, the fifth on 2 and 4).
  var TUNES = {
    // Scott Joplin — The Entertainer (1902)
    entertainer: { bpm: 104, roots: ['C3', 'C3', 'G2', 'C3'],
      melody: 'D5 D#5 E5 C6:2 E5 C6:2  E5 C6:4 r C6 D6  D#6 E6 C6 D6 E6:2 B5 D6  C6:6 r:2' },
    // W. A. Mozart — Piano Sonata No. 11, K. 331, "Rondo alla Turca" (1783)
    turca: { bpm: 126, roots: ['A2', 'C3', 'E2', 'A2'],
      melody: 'B4 A4 G#4 A4 C5:2 r:2  D5 C5 B4 C5 E5:2 r:2  F5 E5 D#5 E5 B5 A5 G#5 A5  B5 A5 G#5 A5 C6:4' },
    // Jacques Offenbach — Galop infernal ("Can-Can"), Orphée aux enfers (1858)
    cancan: { bpm: 132, roots: ['C3', 'G2', 'G2', 'C3'],
      melody: 'C5:2 C5 D5 F5 E5 D5 G5  G5:2 G5 A5 E5 F5 D5 D5  D5:2 D5 F5 E5 D5 C5 C6  B5 A5 G5 F5 E5 D5 C5:2' },
    // Julius Fučík — Entry of the Gladiators, Op. 68 (1897)
    gladiators: { bpm: 116, roots: ['C3', 'G2', 'F2', 'C3'],
      melody: 'E5 D#5 E5 C5 D#5 D5 D#5 B4  D5 C#5 D5 A#4 C#5 C5 C#5 A4  C5 B4 C5 A4 B4 A#4 B4 G#4  A4 B4 C5 D5 E5:2 r:2' },
    // Gioachino Rossini — William Tell Overture, finale (1829)
    williamtell: { bpm: 126, roots: ['C3', 'C3', 'C3', 'G2'],
      melody: 'G4 G4 G4:2 G4 G4 G4:2  G4 G4 C5:2 D5:2 E5:2  G4 G4 G4:2 G4 G4 C5:2  E5 E5 D5:2 B4:2 G4:2' },
  };
  var SEMI = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
  function midi(n) { var m = /^([A-G]#?)(\d)$/.exec(n); return m ? 12 * (Number(m[2]) + 1) + SEMI[m[1]] : null; }
  function hz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function parse(t) {
    var steps = [];
    t.melody.trim().split(/\s+/).forEach(function (tok) {
      var p = tok.split(':'), d = Number(p[1] || 1);
      steps.push({ m: p[0] === 'r' ? null : midi(p[0]), d: d });
    });
    return { bpm: t.bpm, steps: steps, roots: t.roots.map(midi), total: steps.reduce(function (a, s) { return a + s.d; }, 0) };
  }

  var cur = null;   // { id, ctx, out, lead, timer, tune, i, next, beat, beatNext }
  var noiseBuf = null;

  // one oscillator with a plucked envelope: quick attack, exponential decay (no long sustained buzz)
  function pluck(ctx, out, f, at, decay, type, level) {
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f, at);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(level, at + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    o.connect(g); g.connect(out);
    o.start(at); o.stop(at + decay + 0.02);
  }
  function lead(c, m, at, len) {
    var d = Math.min(0.45, Math.max(0.16, len * 0.9)), f = hz(m);
    pluck(c.ctx, c.lead, f, at, d, 'sine', 0.42);              // body
    pluck(c.ctx, c.lead, f * 2, at, d * 0.45, 'sine', 0.09);   // a little "mallet" brightness
  }
  function tuba(c, m, at, beat) {
    pluck(c.ctx, c.out, hz(m), at, Math.min(0.32, beat * 0.55), 'triangle', 0.5);
  }
  function tick(c, at) {   // very quiet brushed off-beat
    var ctx = c.ctx;
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.05), ctx.sampleRate);
      var d = noiseBuf.getChannelData(0);
      for (var i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    }
    var s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuf; f.type = 'highpass'; f.frequency.value = 5000; g.gain.value = 0.06;
    s.connect(f); f.connect(g); g.connect(c.out);
    s.start(at);
  }

  function schedule() {
    var c = cur; if (!c) return;
    var ctx = c.ctx, t = c.tune, step = 30 / t.bpm, beat = 60 / t.bpm, ahead = ctx.currentTime + 0.15;
    while (c.next < ahead) {
      var s = t.steps[c.i];
      if (s.m !== null) lead(c, s.m, c.next, s.d * step);
      c.next += s.d * step;
      if (++c.i >= t.steps.length) c.i = 0;
    }
    while (c.beatNext < ahead) {   // bass on the beat grid; the melody is exactly 4 bars, so both loop together
      var bar = Math.floor(c.beat / 4) % t.roots.length, root = t.roots[bar];
      tuba(c, c.beat % 2 ? root + 7 : root, c.beatNext, beat);
      if (c.beat % 2) tick(c, c.beatNext);
      c.beatNext += beat;
      c.beat = (c.beat + 1) % (t.total / 2);
    }
  }

  function play(ctx, id, volume) {
    if (cur && cur.id === id && cur.ctx === ctx) return;
    stop();
    var tune = TUNES[id]; if (!tune) return;
    var out = ctx.createGain();
    out.gain.value = volume == null ? 0.15 : volume;
    out.connect(ctx.destination);
    var lp = ctx.createBiquadFilter();   // keep the lead warm, never piercing
    lp.type = 'lowpass'; lp.frequency.value = 2200;
    lp.connect(out);
    var start = ctx.currentTime + 0.08;
    cur = { id: id, ctx: ctx, out: out, lead: lp, tune: parse(tune), i: 0, next: start, beat: 0, beatNext: start };
    schedule();
    cur.timer = setInterval(schedule, 30);
  }

  function stop() {
    if (!cur) return;
    var c = cur; cur = null;
    clearInterval(c.timer);
    try {
      c.out.gain.setTargetAtTime(0.0001, c.ctx.currentTime, 0.03);
      setTimeout(function () { try { c.out.disconnect(); } catch (_) {} }, 250);
    } catch (_) {}
  }

  // A short synthesized "meow" (sawtooth through a moving band-pass filter) — no sample file.
  function meow(ctx, volume) {
    var at = ctx.currentTime + 0.02, o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(520, at);
    o.frequency.exponentialRampToValueAtTime(820, at + 0.13);
    o.frequency.exponentialRampToValueAtTime(430, at + 0.5);
    f.type = 'bandpass'; f.Q.value = 5;
    f.frequency.setValueAtTime(1100, at);
    f.frequency.exponentialRampToValueAtTime(1900, at + 0.14);
    f.frequency.exponentialRampToValueAtTime(800, at + 0.5);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime((volume == null ? 0.15 : volume) * 2.2, at + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.55);
    o.connect(f); f.connect(g); g.connect(ctx.destination);
    o.start(at); o.stop(at + 0.6);
  }

  window.PFCatsMusic = { play: play, stop: stop, meow: meow, playing: function () { return !!cur; }, current: function () { return cur && cur.id; }, TUNES: TUNES };
})();
