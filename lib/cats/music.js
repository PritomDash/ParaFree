// ParaFree — Dancing Cats music (lib/cats/music.js). Fetched only after the user clicks 🔊 on the cats.
// Every tune is GENERATED here with WebAudio (short chiptune-style loops) — no audio files, no recordings.
// The melodies are simplified arrangements of public-domain compositions (all composers died before 1930); see
// music/CREDITS.md. Loops are scheduled ahead on the AudioContext clock, so they repeat seamlessly.
(function () {
  'use strict';
  if (window.PFCatsMusic) return;
  // Each tune: tempo (quarter notes per minute), melody in eighth-note steps ("NOTE:steps", r = rest; total = 4 bars of
  // 8 steps), and one bass root per bar (played "oom-pah": root on beats 1 and 3, the fifth on 2 and 4).
  var TUNES = {
    // Offenbach — Galop infernal ("Can-Can"), Orphée aux enfers (1858)
    cancan: { bpm: 144, roots: ['C3', 'G2', 'G2', 'C3'],
      melody: 'C5:2 C5 D5 F5 E5 D5 G5  G5:2 G5 A5 E5 F5 D5 D5  D5:2 D5 F5 E5 D5 C5 C6  B5 A5 G5 F5 E5 D5 C5:2' },
    // Julius Fučík — Entry of the Gladiators, Op. 68 (1897)
    gladiators: { bpm: 126, roots: ['C3', 'G2', 'F2', 'C3'],
      melody: 'E5 D#5 E5 C5 D#5 D5 D#5 B4  D5 C#5 D5 A#4 C#5 C5 C#5 A4  C5 B4 C5 A4 B4 A#4 B4 G#4  A4 B4 C5 D5 E5:2 r:2' },
    // Edvard Grieg — In the Hall of the Mountain King, Peer Gynt Op. 23 (1875)
    mountainking: { bpm: 120, roots: ['A2', 'B2', 'A2', 'C3'],
      melody: 'A4 B4 C5 D5 E5 C5 E5:2  D#5 B4 D#5:2 D5 A#4 D5:2  A4 B4 C5 D5 E5 C5 E5 A5  G5 E5 C5 E5 G5:4' },
    // Nikolai Rimsky-Korsakov — Flight of the Bumblebee, The Tale of Tsar Saltan (1900)
    bumblebee: { bpm: 150, roots: ['A2', 'A2', 'A2', 'E2'],
      melody: 'E6 D#6 D6 C#6 D6 C#6 C6 B5  C6 B5 A#5 A5 G#5 G5 F#5 F5  E5 F5 E5 D#5 E5 F5 F#5 G5  A5 G#5 A5 A#5 B5 A#5 B5 C6' },
    // Gioachino Rossini — William Tell Overture, finale (1829)
    williamtell: { bpm: 138, roots: ['C3', 'C3', 'C3', 'G2'],
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

  var cur = null;   // { id, ctx, out, timer, tune, i, next, beat, beatNext, loopStart }

  function tone(ctx, out, f, at, dur, type, level) {
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f, at);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(level, at + 0.008);
    g.gain.exponentialRampToValueAtTime(level * 0.55, at + Math.min(0.08, dur * 0.5));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(out);
    o.start(at); o.stop(at + dur + 0.02);
  }

  function schedule() {
    var c = cur; if (!c) return;
    var ctx = c.ctx, t = c.tune, step = 30 / t.bpm, beat = 60 / t.bpm, ahead = ctx.currentTime + 0.15;
    while (c.next < ahead) {
      var s = t.steps[c.i];
      if (s.m !== null) tone(ctx, c.lead, hz(s.m), c.next, Math.max(0.06, s.d * step * 0.85), 'square', 0.28);
      c.next += s.d * step;
      if (++c.i >= t.steps.length) { c.i = 0; }
    }
    while (c.beatNext < ahead) {   // bass on the beat grid; the melody is exactly 4 bars, so both loop together
      var bar = Math.floor(c.beat / 4) % t.roots.length, root = t.roots[bar];
      tone(ctx, c.out, hz(c.beat % 2 ? root + 7 : root), c.beatNext, beat * 0.6, 'triangle', 0.5);
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
    var lead = ctx.createBiquadFilter();   // soften the square wave a little
    lead.type = 'lowpass'; lead.frequency.value = 2600;
    lead.connect(out);
    var start = ctx.currentTime + 0.08;
    cur = { id: id, ctx: ctx, out: out, lead: lead, tune: parse(tune), i: 0, next: start, beat: 0, beatNext: start };
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
