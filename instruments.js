// Song Rider Suite instrument engine (window.CRPInstruments).
//
//   CRPInstruments.load(ctx, soundId, destination) -> Promise<instrument>
//
// Works with any BaseAudioContext (the live AudioContext and the OfflineAudioContext used by WAV
// export). The instrument is a drop-in for what soundfont-player's Soundfont.instrument() returns:
//   play(note, when, {duration, gain, velocity, attack, release, cents}) -> voice
//       note: 'C#4' / 'Db4' / MIDI number. The voice is a GainNode with stop(when) and source
//       (an AudioScheduledSourceNode whose 'ended' fires once the voice is silent and disconnected).
//   start (= play), stop(when), connect(destination) -> itself, disconnect(), out (output GainNode)
// and adds:
//   createPlayer(ctx, destination): another player on any context, sharing the decoded samples
//   voiceCount(), dispose(), engine: 'crp-instruments', kind: 'sample' | 'derived' | 'layered' | 'synth'
//
// Where a sound comes from, in order:
//   1. its own recorded sample set: <basePath>/<id>/manifest.json + audio, listed in <basePath>/index.json
//   2. a voice derived from another set by engine-side processing (EQ, chorus, palm mute, amp sim, layering)
//   3. a synthesized voice (at most 3 oscillators per note; no per-voice convolution)
// When none can play (set not delivered yet, offline, decode error) load() rejects with
// err.unavailable === true and the caller falls back to the SoundFont.
//
// Levels: every engine instrument is calibrated to the suite's reference level (the old SoundFont
// piano through its bus gain: -27.9 dBFS gated RMS for REFERENCE, a chord + melody, measured before
// the master), on the mean of its full-range and phone-speaker loudness (balancedDb). A sample set levels itself when it loads by rendering REFERENCE once offline (the
// manifest "trim" adjusts on top); derived, layered and synthesized voices carry measured trims (see
// LEVEL_DB). The caller applies CRPInstruments.busGain (1) instead of its SoundFont table for sounds
// this engine serves.
(() => {
  'use strict';
  const VERSION = '1.2.0';
  const preset = (typeof window !== 'undefined' && window.CRP_INSTRUMENTS_CONFIG) || {};
  const config = { basePath: String(preset.basePath || 'assets/instruments/'), disabled: !!preset.disabled };

  // ---------------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------------
  const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function toMidi(note) {
    if (typeof note === 'number') return Number.isFinite(note) ? note : null;
    const s = String(note ?? '').trim();
    if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
    const m = s.match(/^([A-Ga-g])([#b♯♭x]*)(-?\d+)$/);
    if (!m) return null;
    let pc = LETTER_PC[m[1].toUpperCase()];
    for (const ch of m[2]) pc += ch === 'x' ? 2 : (ch === '#' || ch === '♯') ? 1 : -1;
    return (Number(m[3]) + 1) * 12 + pc;
  }
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const dbToGain = db => Math.pow(10, db / 20);
  const isBassId = id => /(?:^|_)bass(?:_|$)/.test(String(id));
  function unavailable(id, why) {
    const e = new Error(`No engine instrument for ${id}${why ? ` (${why})` : ''}`);
    e.unavailable = true; e.code = 'unavailable';
    return e;
  }
  function biquad(ctx, type, freq, q, gainDb) {
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = clamp(freq, 10, ctx.sampleRate * .45);
    if (q != null) f.Q.value = q;
    if (gainDb != null) f.gain.value = gainDb;
    return f;
  }
  function gainNode(ctx, value = 1) { const g = ctx.createGain(); g.gain.value = value; return g; }
  function series(nodes) { for (let i = 1; i < nodes.length; i++) nodes[i - 1].connect(nodes[i]); return nodes; }

  // Release shape: exponential to -60 dB, then a short linear step to true zero before the sources stop.
  const FLOOR = .001, TAIL = .012, STEAL_FADE = .03;

  // ---------------------------------------------------------------------------------------------
  // Per-context resources (PeriodicWaves cannot cross contexts; AudioBuffers and curves can)
  // ---------------------------------------------------------------------------------------------
  const perContext = new WeakMap();
  let noiseBuffer = null;
  const WAVE_SPECS = {
    // Hammond-style registration 68 8600 300 on one oscillator. Harmonics are relative to the 16'
    // fundamental (the oscillator runs at half the key's pitch): 16'=1, 8'=2, 5 1/3'=3, 4'=4, 2'=8.
    // Drawbar step = 3 dB: 8 -> 1, 6 -> .5, 3 -> .178.
    drawbar: () => { const h = new Float32Array(17); h[1] = .5; h[2] = 1; h[3] = 1; h[4] = .5; h[8] = .178; return { imag: h }; },
    // Narrow pulse (22% duty) for the clavinet.
    pulse22: () => {
      const n = 256, real = new Float32Array(n), imag = new Float32Array(n), d = .22;
      for (let k = 1; k < n; k++) real[k] = 2 / (k * Math.PI) * Math.sin(k * Math.PI * d);
      return { real, imag };
    },
  };
  const waveData = new Map();
  function resources(ctx) {
    let r = perContext.get(ctx);
    if (r) return r;
    const waves = new Map();
    r = {
      noise() {
        if (!noiseBuffer) {
          const len = Math.round(ctx.sampleRate * 2), b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
          let seed = 22222; for (let i = 0; i < len; i++) { seed = (seed * 16807) % 2147483647; d[i] = seed / 1073741823.5 - 1; }
          noiseBuffer = b;
        }
        return noiseBuffer;
      },
      wave(name) {
        let w = waves.get(name);
        if (!w) {
          let spec = waveData.get(name); if (!spec) waveData.set(name, spec = WAVE_SPECS[name]());
          const n = (spec.real || spec.imag).length;
          w = ctx.createPeriodicWave(spec.real || new Float32Array(n), spec.imag || new Float32Array(n));
          waves.set(name, w);
        }
        return w;
      },
    };
    perContext.set(ctx, r);
    return r;
  }
  // Waveshaper curves (shared Float32Arrays). Asymmetric soft clip: the bias makes the two halves
  // saturate differently (even harmonics, like a tube stage); the DC it adds is removed afterwards.
  const curves = new Map();
  function softClipCurve(k, bias) {
    const key = `${k}:${bias}`;
    let c = curves.get(key);
    if (c) return c;
    const n = 2048, off = Math.tanh(k * bias), top = Math.tanh(k * (1 + bias)) - off;
    c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = (Math.tanh(k * (x + bias)) - off) / top; }
    curves.set(key, c);
    return c;
  }

  // An LFO that only runs while the player is sounding. Each busy period gets its own oscillator, started
  // at phase 0 (no jump in the modulated parameter) and stopped after the last tail, so idle or discarded
  // players never leave a running oscillator behind.
  function managedLfo(ctx, rate, targets) {
    const depths = targets.map(([param, amount]) => { const g = gainNode(ctx, amount); g.connect(param); return g; });
    let osc = null, stopAt = 0;
    return {
      nodes: depths,
      ensure(when, until) {
        if (osc && stopAt > when) { if (until > stopAt) { stopAt = until; try { osc.stop(stopAt); } catch {} } return; }
        const o = ctx.createOscillator();
        o.frequency.value = rate;
        for (const g of depths) o.connect(g);
        o.start(Math.max(ctx.currentTime, Math.min(when, stopAt > ctx.currentTime ? stopAt : when)));
        o.stop(until);
        o.addEventListener('ended', () => { try { o.disconnect(); } catch {} if (osc === o) osc = null; });
        osc = o; stopAt = until;
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Player-level effect chains: (ctx) -> {input, output, touch?(when, until)}
  // ---------------------------------------------------------------------------------------------
  function eqChain(specs) {
    return ctx => {
      const nodes = specs.map(([type, f, q, g]) => biquad(ctx, type, f, q, g));
      series(nodes);
      return { input: nodes[0], output: nodes[nodes.length - 1] };
    };
  }
  // Stereo modulated delay (chorus / rotary): a dry path plus two delay lines modulated in opposite
  // phase, one per side. `trem` adds the matching amplitude modulation of a rotating speaker.
  function modChain(pre, o) {
    return ctx => {
      const input = gainNode(ctx), output = gainNode(ctx), head = pre ? pre(ctx) : null;
      if (head) input.connect(head.input);
      const src = head ? head.output : input;
      const dry = gainNode(ctx, o.dry), dA = ctx.createDelay(.05), dB = ctx.createDelay(.05);
      const gA = gainNode(ctx, o.wet), gB = gainNode(ctx, o.wet), merge = ctx.createChannelMerger(2);
      dA.delayTime.value = o.base; dB.delayTime.value = o.base;
      src.connect(dry); dry.connect(output);
      src.connect(dA); dA.connect(gA); gA.connect(merge, 0, 0);
      src.connect(dB); dB.connect(gB); gB.connect(merge, 0, 1);
      merge.connect(output);
      const lfo = managedLfo(ctx, o.rate, [[dA.delayTime, o.depth], [dB.delayTime, -o.depth], ...(o.trem ? [[gA.gain, o.trem], [gB.gain, -o.trem]] : [])]);
      return { input, output, touch: lfo.ensure };
    };
  }
  // Guitar amp: pre-EQ -> drive -> 4x oversampled asymmetric soft clipper -> cabinet EQ and a
  // 24 dB/oct roll-off near 5 kHz. One shaper per player (not per note), so it stays cheap.
  const AMPS = {
    // drive assumes a self-levelled clean set (the amp sees the reference level, not the raw recording).
    overdrive: { hp: 90, mid: [760, .9, 7], drive: 11, k: 2.2, bias: .18, post: [[120, 1, 1.5], [420, 1.2, -2], [2000, 1, 2]], lp: [5600, 5000], make: .5 },
    distortion: { hp: 110, mid: [700, .8, 4], drive: 40, k: 2.6, bias: .12, post: [[110, 1, 2.5], [450, 1.1, -5], [2400, 1, 2.5]], lp: [5200, 4600], make: .36 },
  };
  function ampChain(kind) {
    const P = AMPS[kind];
    return ctx => {
      const input = biquad(ctx, 'highpass', P.hp, -3), mid = biquad(ctx, 'peaking', P.mid[0], P.mid[1], P.mid[2]);
      const drive = gainNode(ctx, P.drive), shaper = ctx.createWaveShaper();
      shaper.curve = softClipCurve(P.k, P.bias); shaper.oversample = '4x';
      const dc = biquad(ctx, 'highpass', 70, -3);
      const post = P.post.map(([f, q, g]) => biquad(ctx, 'peaking', f, q, g));
      const lp1 = biquad(ctx, 'lowpass', P.lp[0], -3), lp2 = biquad(ctx, 'lowpass', P.lp[1], -3), output = gainNode(ctx, P.make);
      series([input, mid, drive, shaper, dc, ...post, lp1, lp2, output]);
      return { input, output };
    };
  }
  // Rhodes: a gentle tanh stage (hard notes "bark" a little more), warmth and a pickup roll-off.
  function rhodesChain(ctx) {
    const input = gainNode(ctx, 1.6), shaper = ctx.createWaveShaper();
    shaper.curve = softClipCurve(1.2, .04); shaper.oversample = '2x';
    const nodes = series([input, shaper, gainNode(ctx, .7), biquad(ctx, 'lowshelf', 180, null, 2), biquad(ctx, 'lowpass', 7500, -3)]);
    return { input, output: nodes[nodes.length - 1] };
  }

  const CHAINS = {
    bright: eqChain([['lowshelf', 220, null, -1.5], ['peaking', 2600, .9, 2.5], ['highshelf', 4200, null, 4.5]]),
    egrand: modChain(eqChain([['highpass', 70, -3], ['lowshelf', 200, null, -4], ['peaking', 1100, 1, 4], ['peaking', 3200, 1.2, 2.5], ['highshelf', 7500, null, -5]]), { rate: .55, base: .007, depth: .0016, dry: .8, wet: .4 }),
    jazz: eqChain([['lowshelf', 220, null, 2], ['lowpass', 2300, -1], ['highshelf', 3500, null, -3]]),
    muted: eqChain([['lowshelf', 160, null, 3], ['lowpass', 1800, -2]]),
    overdrive: ampChain('overdrive'),
    distortion: ampChain('distortion'),
    epChorus: modChain(null, { rate: .7, base: .006, depth: .0012, dry: .85, wet: .35 }),
    strings: modChain(eqChain([['highpass', 140, -3], ['peaking', 2400, .8, 2.5], ['highshelf', 7000, null, -3]]), { rate: .45, base: .009, depth: .0018, dry: .75, wet: .45 }),
    rotary: modChain(null, { rate: .78, base: .0032, depth: .0011, dry: .6, wet: .55, trem: .14 }),
    rhodes: rhodesChain,
    clav: eqChain([['highpass', 150, -3], ['peaking', 1450, 1.1, 4], ['peaking', 3600, 1.6, 3]]),
  };

  // ---------------------------------------------------------------------------------------------
  // Synthesized voices. build(api) creates the note's graph and returns the node feeding the amp
  // envelope. api.osc() registers pitched oscillators (glide + vibrato are applied to all of them);
  // every voice uses at most 3 oscillators. Vibrato and pitch blips are detune curves, not LFO
  // oscillators, so a 4-note chord never creates more than 12 oscillators.
  // ---------------------------------------------------------------------------------------------
  function filterEnv(param, t, start, peak, attack, sustain, tau, nyq) {
    param.setValueAtTime(clamp(start, 20, nyq), t);
    param.exponentialRampToValueAtTime(clamp(peak, 20, nyq), t + attack);
    param.setTargetAtTime(clamp(sustain, 20, nyq), t + attack, tau);
  }
  const SYNTHS = {
    // GM Lead 2 (sawtooth): two detuned saws + a quiet square for body, resonant low-pass with a snappy envelope.
    saw_lead: {
      levelDb: -11.4, peak: .2, maxVoices: 10, velAmp: .3, amp: { attack: .006, decay: .35, sustain: .78, release: .2 },
      vib: { rate: 5.5, depth: 7, delay: .35, fade: .5 },
      build(a) {
        const { f, vel, t, nyq } = a, x = a.osc('sawtooth', 1, -7), y = a.osc('sawtooth', 1, 7), s = a.osc('square', 1);
        const sg = a.gain(.3), lp = a.filter('lowpass', 1000, 2.5);
        s.connect(sg); x.connect(lp); y.connect(lp); sg.connect(lp);
        filterEnv(lp.frequency, t, f * 1.6 + 380, f * 9 + 2400 + 3000 * vel, .012, f * 4.2 + 1200, .3, nyq);
        return lp;
      },
    },
    // Warm pad: slow detuned saws + a triangle for a round fundamental, soft low-pass that opens with the attack.
    warm_pad: {
      levelDb: -9.3, peak: .32, maxVoices: 12, amp: { attack: .75, curve: 'exp', release: 1.4 },
      vib: { rate: 4.6, depth: 5, delay: .3, fade: 1.2, spread: .12 },
      build(a) {
        const { f, t } = a, x = a.osc('sawtooth', 1, -6), y = a.osc('sawtooth', 1, 6), tri = a.osc('triangle', 1);
        const sg = a.gain(.5), tg = a.gain(.55), lp = a.filter('lowpass', 800, -1);
        x.connect(sg); y.connect(sg); tri.connect(tg); sg.connect(lp); tg.connect(lp);
        const c = Math.min(3600, f * 1.5 + 850);
        lp.frequency.setValueAtTime(c * .55, t); lp.frequency.setTargetAtTime(c, t, .45);
        return lp;
      },
    },
    // Poly synth pad: brighter saw/square stack with a filter sweep that opens and settles.
    poly_pad: {
      levelDb: -13.1, peak: .2, maxVoices: 12, amp: { attack: .08, decay: .9, sustain: .85, release: .75 },
      vib: { rate: 5, depth: 4, delay: .5, fade: .8, spread: .1 },
      build(a) {
        const { f, t, nyq } = a, x = a.osc('sawtooth', 1, -8), y = a.osc('sawtooth', 1, 8), q = a.osc('square', 1, 3);
        const qg = a.gain(.4), lp = a.filter('lowpass', 800, 4);
        q.connect(qg); x.connect(lp); y.connect(lp); qg.connect(lp);
        lp.frequency.setValueAtTime(clamp(f * 1.1 + 280, 20, nyq), t);
        lp.frequency.setTargetAtTime(clamp(f * 8 + 2600, 20, nyq), t, .33);
        lp.frequency.setTargetAtTime(clamp(f * 4 + 1500, 20, nyq), t + .95, 1.1);
        return lp;
      },
    },
    // String ensemble: three detuned saws, each with its own vibrato rate, slow attack, string-machine EQ + chorus.
    strings: {
      levelDb: -11.9, peak: .2, maxVoices: 12, chain: 'strings', amp: { attack: .34, curve: 'exp', release: .95 },
      vib: { rate: 5.4, depth: 7, delay: .18, fade: .6, spread: .18 },
      build(a) {
        const { f, t, nyq } = a, lp = a.filter('lowpass', 1000, -2);
        for (const c of [0, 11, -13]) a.osc('sawtooth', 1, c).connect(lp);
        const top = clamp(f * 3 + 2600, 20, Math.min(9500, nyq));
        lp.frequency.setValueAtTime(top * .5, t); lp.frequency.setTargetAtTime(top, t, .25);
        return lp;
      },
    },
    // Synth brass: saws through a brassy filter envelope with a small upward pitch blip on the attack.
    synth_brass: {
      levelDb: -12.5, peak: .24, maxVoices: 10, velAmp: .25, amp: { attack: .03, decay: .45, sustain: .72, release: .26 },
      vib: { rate: 5.2, depth: 6, delay: .4, fade: .5 }, blip: { cents: -30, time: .045 },
      build(a) {
        const { f, vel, t, nyq } = a, x = a.osc('sawtooth', 1, -6), y = a.osc('sawtooth', 1, 6), s = a.osc('square', 1);
        const sg = a.gain(.22), lp = a.filter('lowpass', 800, 2);
        s.connect(sg); x.connect(lp); y.connect(lp); sg.connect(lp);
        filterEnv(lp.frequency, t, f * 1.05 + 180, f * 7 + 1900 + 1600 * vel, .075, f * 3.2 + 950, .38, nyq);
        return lp;
      },
    },
    // G-funk "worm" lead (Moog style): saw + square through a resonant low-pass that tracks the pitch, over a
    // sine for a round body; portamento between consecutive notes, delayed wide vibrato. The overtones up to
    // about the 6th harmonic are what a phone speaker can play (a near-pure sine is inaudible on one below
    // ~500 Hz). The suite's worm filter-wobble fx runs after it.
    worm: {
      levelDb: -21.1, leadDb: 2, peak: .5, maxVoices: 6, amp: { attack: .014, sustain: 1, release: .14 }, glide: { time: .085, gap: .14 },
      vib: { rate: 5.6, depth: 24, delay: .14, fade: .32 },
      build(a) {
        const { f, nyq } = a, w = a.osc('sawtooth', 1, 3), q = a.osc('square', 1, -3), s = a.osc('sine', 1);
        const wg = a.gain(.65), qg = a.gain(.32), sg = a.gain(.35), lp = a.filter('lowpass', clamp(f * 5 + 900, 20, Math.min(9000, nyq)), 2.4), mix = a.gain(1);
        w.connect(wg); q.connect(qg); wg.connect(lp); qg.connect(lp); s.connect(sg); sg.connect(mix); lp.connect(mix);
        return mix;
      },
    },
    // G-funk whistle: pure sine with a breath of band-passed noise (a little "chiff" on the attack), glide
    // between consecutive notes and a delayed vibrato. It sounds an octave above the written note, like a
    // real whistle (about 500-3000 Hz): written at C4, a whistle would sit below any whistler's range and
    // below what a phone speaker can play.
    whistle: {
      levelDb: -21.8, leadDb: 2, peak: .5, maxVoices: 6, octave: 1, amp: { attack: .04, sustain: 1, release: .1 }, glide: { time: .07, gap: .14 },
      vib: { rate: 6.1, depth: 20, delay: .16, fade: .3 },
      build(a) {
        const { f, t } = a, s = a.osc('sine', 1), h = a.osc('sine', 2), hg = a.gain(.06);
        const nz = a.noise(), bp = a.filter('bandpass', clamp(f * 2, 1600, 9000), 2.2), ng = a.gain(0), mix = a.gain(1);
        h.connect(hg); nz.connect(bp); bp.connect(ng);
        ng.gain.setValueAtTime(.16, t); ng.gain.setTargetAtTime(.05, t + .02, .05);
        s.connect(mix); hg.connect(mix); ng.connect(mix);
        return mix;
      },
    },
    // Drawbar organ: all drawbars on one additive oscillator, third-harmonic percussion, key click,
    // slow rotary-style chorus/tremolo on the player.
    organ: {
      levelDb: -9.3, peak: .32, maxVoices: 14, chain: 'rotary', amp: { attack: .004, sustain: 1, release: .05 },
      build(a) {
        const { t } = a, m = a.osc(a.wave('drawbar'), .5), p = a.osc('sine', 3), pg = a.gain(0);
        p.connect(pg);
        pg.gain.setValueAtTime(0, t); pg.gain.linearRampToValueAtTime(.3, t + .002); pg.gain.setTargetAtTime(0, t + .002, .16);
        const ck = a.oneShotNoise(t, .03), cb = a.filter('bandpass', 2600, .7), cg = a.gain(0), mix = a.gain(1);
        ck.connect(cb); cb.connect(cg);
        cg.gain.setValueAtTime(0, t); cg.gain.linearRampToValueAtTime(.22, t + .0008); cg.gain.setTargetAtTime(0, t + .0008, .0035);
        m.connect(mix); pg.connect(mix); cg.connect(mix);
        return mix;
      },
    },
    // DX-style FM electric piano: one carrier, a 1:1 modulator for the body and a 14:1 modulator for the
    // tine attack (index decays fast); both indexes follow velocity and soften up the keyboard.
    dx_ep: {
      levelDb: -9.2, peak: .3, maxVoices: 16, chain: 'epChorus', velAmp: .4,
      amp: { attack: .0015, decay: .42, sustain: .45, decay2At: .5, decay2: 2.4, sustain2: 0, keyscale: true, release: .3 },
      build(a) {
        const { f, vel, t, midi } = a, c = a.osc('sine', 1), m1 = a.osc('sine', 1, 3), m2 = a.osc('sine', 14);
        const i1 = a.gain(0), i2 = a.gain(0), ks = Math.pow(2, -(midi - 60) / 24);
        m1.connect(i1); i1.connect(c.frequency); m2.connect(i2); i2.connect(c.frequency);
        const I1 = .55 + 1.1 * vel, I2 = (.35 + .9 * vel) * clamp(1.2 - (midi - 60) / 36, .25, 1), fm1 = f * m1._ratio, fm2 = f * 14;
        i1.gain.setValueAtTime(I1 * fm1, t); i1.gain.setTargetAtTime(I1 * .22 * fm1, t, .5 * ks);
        i2.gain.setValueAtTime(I2 * fm2, t); i2.gain.setTargetAtTime(0, t, .035);
        return c;
      },
    },
    // Rhodes-style electric piano (used when no sample set is delivered): sine carrier with a 1:1
    // modulator whose index grows with velocity (bark), plus a fast-decaying tine "bell" partial.
    rhodes: {
      levelDb: -14.3, peak: .32, maxVoices: 16, chain: 'rhodes', velAmp: .45,
      amp: { attack: .002, decay: .4, sustain: .55, decay2At: .45, decay2: 2.6, sustain2: 0, keyscale: true, release: .3 },
      build(a) {
        const { f, vel, t, midi } = a, ks = Math.pow(2, -(midi - 60) / 24);
        const c = a.osc('sine', 1), m = a.osc('sine', 1), bell = a.osc('sine', 6.27);
        const im = a.gain(0), bg = a.gain(0), mix = a.gain(1);
        m.connect(im); im.connect(c.frequency); bell.connect(bg); c.connect(mix); bg.connect(mix);
        const I = .12 + 1.7 * vel * vel, B = (.06 + .22 * vel) * clamp(1.15 - (midi - 60) / 48, .3, 1);
        im.gain.setValueAtTime(I * f, t); im.gain.setTargetAtTime(I * .3 * f, t, .22 * ks);
        bg.gain.setValueAtTime(B, t); bg.gain.setTargetAtTime(0, t, .16 * ks);
        return mix;
      },
    },
    // Clavinet (used when no sample set is delivered): narrow pulse + saw through a resonant low-pass
    // that snaps shut, fast decay, thin "quacky" pickup EQ.
    clav: {
      levelDb: -11.0, peak: .3, maxVoices: 12, chain: 'clav', velAmp: .35,
      amp: { attack: .0015, decay: .55, sustain: 0, keyscale: true, release: .07 },
      build(a) {
        const { f, vel, t, nyq } = a, p = a.osc(a.wave('pulse22'), 1), s = a.osc('sawtooth', 1, 5);
        const sg = a.gain(.35), lp = a.filter('lowpass', 2000, 7);
        s.connect(sg); p.connect(lp); sg.connect(lp);
        lp.frequency.setValueAtTime(clamp(f * 14 + 2800 + 3000 * vel, 20, nyq), t);
        lp.frequency.setTargetAtTime(clamp(f * 3 + 700, 20, nyq), t, .09);
        return lp;
      },
    },
  };

  // ---------------------------------------------------------------------------------------------
  // What each sound id is made of
  // ---------------------------------------------------------------------------------------------
  //   synth: always synthesized | own: use <id>'s own set when delivered | derive: [baseSet, fx]
  //   layer: sets to stack when no own set | fallbackSynth: synth when no set | alias: same as another id
  const DEFS = {
    acoustic_grand_piano: {},
    bright_acoustic_piano: { derive: ['acoustic_grand_piano', 'bright'] },
    electric_grand_piano: { derive: ['acoustic_grand_piano', 'egrand'] },
    electric_piano_1: { fallbackSynth: 'rhodes' },
    electric_piano_2: { synth: 'dx_ep' },
    synth_strings_1: { synth: 'strings' },
    pad_2_warm: { synth: 'warm_pad' },
    pad_3_polysynth: { synth: 'poly_pad' },
    lead_2_sawtooth: { synth: 'saw_lead' },
    electric_bass_finger: {},
    acoustic_guitar_steel: {},
    acoustic_guitar_nylon: {},
    electric_guitar_clean: {},
    electric_guitar_jazz: { derive: ['electric_guitar_clean', 'jazz'] },
    electric_guitar_muted: { derive: ['electric_guitar_clean', 'muted'] },
    overdriven_guitar: { derive: ['electric_guitar_clean', 'overdrive'] },
    distortion_guitar: { derive: ['electric_guitar_clean', 'distortion'] },
    wah_wah_guitar: { alias: 'overdriven_guitar' }, // + the suite's wah fx (createInstrumentFxChain)
    tenor_sax: {}, alto_sax: {}, french_horn: {}, trumpet: {}, trombone: {}, tuba: {}, flute: {},
    brass_section: { layer: ['trumpet', 'trombone', 'french_horn'] },
    clavinet: { fallbackSynth: 'clav' },
    funky_worm: { synth: 'worm' }, // + the suite's worm fx
    drawbar_organ: { synth: 'organ' },
    vibraphone: {}, marimba: {},
    whistle: { synth: 'whistle' },
    synth_brass_1: { synth: 'synth_brass' },
  };
  // Processing applied to sample voices of derived sounds (voice-level part; the chain is player-level).
  const SAMPLE_FX = {
    bright: { chain: 'bright', levelDb: -.3 },
    egrand: { chain: 'egrand', attack: .003, levelDb: -.1 },
    jazz: { chain: 'jazz', attack: .014, levelDb: -.1 },
    muted: { chain: 'muted', attack: .003, release: .05, maxLen: .6, palm: true, levelDb: 5.9 },
    overdrive: { chain: 'overdrive', levelDb: -23.4 },
    distortion: { chain: 'distortion', levelDb: -21.6 },
  };
  // Level trims (dB), measured so each sound matches the piano reference (see the header):
  //   SYNTHS[..].levelDb      synthesized voices (absolute); SYNTHS[..].leadDb puts a lead above the match
  //   SAMPLE_FX[..].levelDb   derived voices, relative to the (self-levelled) set they are made from
  //   LAYER_LEVEL_DB          a stacked section, relative to its (self-levelled) sets
  //   ALIAS_LEVEL_DB          a sound played through another one's model (+ the suite's fx)
  //   LEVEL_DB[id]            optional taste trim for a delivered set of that id, on top of its
  //                           self-levelling (PRINT_LEVELS=1 node tests/e2e/instruments.test.mjs).
  const LEVEL_DB = {};
  const LAYER_LEVEL_DB = 1.2;
  const ALIAS_LEVEL_DB = { wah_wah_guitar: -2.6 };
  // Layer mix for a stacked brass section: weight, detune (cents) and onset offset (s) per set.
  const BRASS_LAYERS = [{ weight: .55, cents: 4, delay: 0 }, { weight: .5, cents: -5, delay: .009 }, { weight: .45, cents: 0, delay: .016 }];

  // ---------------------------------------------------------------------------------------------
  // Sample sets
  // ---------------------------------------------------------------------------------------------
  // Target for autoNorm(), the quick estimate used only when the offline calibration render is not
  // possible (calibrated with the fixture piano: within about 1 dB of the render on the test sets).
  const REF_EST_DB = -25.9;
  const RETRY_MS = 30000, MAX_SETS = 8;
  function baseUrl() {
    const p = config.basePath.endsWith('/') ? config.basePath : config.basePath + '/';
    try { return new URL(p, document.baseURI).href; } catch { return p; }
  }
  function parseIndex(data) {
    const ids = new Set(), add = v => { if (typeof v === 'string') ids.add(v); else if (v && typeof v.id === 'string') ids.add(v.id); };
    if (Array.isArray(data)) data.forEach(add);
    else if (data && typeof data === 'object') {
      for (const k of ['instruments', 'ids', 'sets', 'delivered', 'available']) if (Array.isArray(data[k])) data[k].forEach(add);
      if (!ids.size) for (const [k, v] of Object.entries(data)) if (v && typeof v === 'object' && !Array.isArray(v) && DEFS[k]) ids.add(k);
    }
    return ids;
  }
  let indexState = null;
  function loadIndex() {
    const now = Date.now();
    if (indexState && (indexState.ok || now - indexState.at < RETRY_MS)) return indexState.promise;
    const st = { at: now, ok: false, ids: null };
    st.promise = fetch(baseUrl() + 'index.json')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => { st.ids = parseIndex(d); st.ok = true; return st.ids; }, () => null);
    indexState = st;
    return st.promise;
  }
  function decode(ctx, data) {
    return new Promise((resolve, reject) => {
      let done = false;
      const ok = b => { if (!done) { done = true; resolve(b); } }, bad = e => { if (!done) { done = true; reject(e || new Error('Could not decode audio')); } };
      try { const p = ctx.decodeAudioData(data, ok, bad); if (p && typeof p.then === 'function') p.then(ok, bad); } catch (e) { bad(e); }
    });
  }
  // First audible sample (-50 dB below the peak), minus 1 ms: mp3 encoders pad the start with silence.
  // `from` (seconds) skips decoder padding first, so padded and unpadded decodes start on the same sample.
  function leadingSilence(buffer, from = 0) {
    const sr = buffer.sampleRate, n = buffer.length, chans = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
    let peak = 0;
    for (const d of chans) for (let i = 0; i < n; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
    const thr = Math.max(1e-4, peak * .003), i0 = Math.round(from * sr), lim = Math.min(n, i0 + Math.round(.25 * sr));
    for (let i = i0; i < lim; i++) for (const d of chans) if (Math.abs(d[i]) > thr) return Math.max(from, i / sr - .001);
    return from;
  }
  // MP3 decoders that ignore the LAME gapless header (Safari) return the encoder + decoder delay
  // (576 + 529 samples at 44.1 kHz) as extra audio at the start, which would shift every loop point.
  // A manifest that lists each file's true length (`frames` at `sampleRate`) lets us detect that.
  const MP3_DELAY_S = 1105 / 44100;
  function decoderPadding(s, buffer, rate) {
    const frames = Number(s.frames);
    if (!(frames > 0)) return 0;
    const extra = buffer.duration - frames / rate;
    return extra > .004 ? Math.min(extra, MP3_DELAY_S) : 0;
  }
  function prepSample(s, buffer, rate = 44100) {
    const dur = buffer.duration, secs = v => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) || n < 0 ? null : n; };
    const pad = decoderPadding(s, buffer, rate);
    let ls = secs(s.loopStart), le = secs(s.loopEnd);
    if (ls != null && le != null) { ls += pad; le += pad; }
    if (!(ls != null && le != null && le - ls > .01 && le <= dur + 1e-6)) ls = le = null;
    const offset = clamp((Number(s.offset ?? s.start) || 0) + leadingSilence(buffer, pad), 0, Math.max(0, dur - .05));
    const gain = Number(s.gain);
    return {
      midi: Number(s.midi), vel: clamp(Number(s.vel ?? s.velocity ?? 100) || 100, 1, 127), buffer, offset,
      tune: Number(s.tune ?? s.cents) || 0, gain: Number.isFinite(gain) && gain > 0 ? gain : 1, loopStart: ls, loopEnd: le, file: String(s.file),
    };
  }
  // Nearest sample by pitch, then velocity layer; ties prefer the sample above (pitched down).
  function pickSample(set, midi, vel) {
    let best = null, cost = Infinity;
    for (const s of set.samples) {
      const dm = s.midi - midi, c = Math.abs(dm) + (dm < 0 ? .01 : 0) + Math.abs(s.vel - vel) / 24 + (s.vel < vel ? .001 : 0);
      if (c < cost) { cost = c; best = s; }
    }
    return best;
  }
  // Mean square of a note played from sample s at playback rate `rate`, between t0 and t1 (seconds of output).
  function meanSquare(s, rate, t0, t1) {
    const b = s.buffer, sr = b.sampleRate, base = Math.floor(s.offset * sr);
    let i0 = base + Math.floor(t0 * rate * sr), i1 = base + Math.floor(t1 * rate * sr);
    const want = Math.max(1, i1 - i0);
    if (s.loopEnd != null && i0 >= b.length) { i0 = Math.floor(s.loopStart * sr); i1 = Math.floor(s.loopEnd * sr); }
    i1 = Math.min(b.length, i1);
    if (i1 <= i0) return 0;
    let sum = 0;
    for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = i0; i < i1; i++) sum += d[i] * d[i]; }
    const ms = sum / ((i1 - i0) * b.numberOfChannels);
    return s.loopEnd != null ? ms : ms * (i1 - i0) / want; // unlooped samples are silent after their end
  }
  // The level reference: a chord, then a short melody (bass sounds an octave lower). Every engine sound
  // is levelled so this phrase measures REFERENCE.balancedDb (see balancedDb()) before the master: the
  // piano then measures REFERENCE.gatedDb (gated RMS) on a full-range system, as it did before.
  const REFERENCE = {
    gatedDb: -27.9, balancedDb: -30.7,
    chord: [60, 64, 67], melody: [64, 67, 69, 72, 67, 64, 62, 60], bassShift: -12,
    chordAt: .3, chordDur: 1.6, chordGain: .95, melodyAt: 2.5, step: .3, noteDur: .28, noteGain: .92, seconds: 5.6,
  };
  function playReference(player, bass) {
    const R = REFERENCE, sh = bass ? R.bassShift : 0;
    for (const m of R.chord) player.play(m + sh, R.chordAt, { duration: R.chordDur, gain: R.chordGain });
    R.melody.forEach((m, i) => player.play(m + sh, R.melodyAt + i * R.step, { duration: R.noteDur, gain: R.noteGain }));
  }
  // Gated RMS in dBFS: 400 ms blocks every 100 ms, -70 dBFS absolute and -10 dB relative gates
  // (BS.1770-style gating without the K filter), so short plucks are not penalised for silence.
  function gatedDb(x, sr) {
    const blk = Math.round(.4 * sr), hop = Math.round(.1 * sr), blocks = [];
    for (let s = 0; s + blk <= x.length; s += hop) { let e = 0; for (let i = s; i < s + blk; i++) e += x[i] * x[i]; blocks.push(e / blk); }
    const abs = blocks.filter(e => e > 1e-7), mean = abs.reduce((a, b) => a + b, 0) / Math.max(1, abs.length), rel = abs.filter(e => e > mean * .1);
    return 10 * Math.log10(Math.max(1e-12, rel.reduce((a, b) => a + b, 0) / Math.max(1, rel.length)));
  }
  // A small phone speaker plays almost nothing below ~500 Hz: two 2nd-order high-passes at 500 Hz (24 dB/oct).
  function phoneWeighted(x, sr) {
    const w = 2 * Math.PI * 500 / sr, al = Math.sin(w) / (2 * Math.SQRT1_2), c = Math.cos(w), a0 = 1 + al;
    const b0 = (1 + c) / 2 / a0, b1 = -(1 + c) / a0, b2 = b0, a1 = -2 * c / a0, a2 = (1 - al) / a0;
    let y = x;
    for (let pass = 0; pass < 2; pass++) {
      const out = new Float32Array(y.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < y.length; i++) { const v = y[i], o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; out[i] = o; x2 = x1; x1 = v; y2 = y1; y1 = o; }
      y = out;
    }
    return y;
  }
  // The level every sound is matched on: the mean of its gated level on a full-range system and through a
  // phone speaker, so mellow, fundamental-heavy sounds are not lost on phones nor boom on big speakers.
  const balancedDb = (x, sr) => (gatedDb(x, sr) + gatedDb(phoneWeighted(x, sr), sr)) / 2;
  // Self-levelling, part 1 (fallback): a quick estimate of the phrase's power from the samples it uses.
  function autoNorm(set, bass) {
    const R = REFERENCE, sh = bass ? R.bassShift : 0, note = (m, t1) => {
      const s = pickSample(set, m + sh, 95);
      return s ? meanSquare(s, Math.pow(2, (m + sh - s.midi + s.tune / 100) / 12), 0, t1) * s.gain * s.gain : 0;
    };
    const ec = R.chord.reduce((a, m) => a + note(m, R.chordDur), 0), em = R.melody.reduce((a, m) => a + note(m, R.noteDur), 0) / R.melody.length;
    const power = (R.chordDur * ec + 2.4 * em * R.noteDur / R.step) / 4;
    return power > 0 ? clamp(dbToGain(REF_EST_DB - 10 * Math.log10(power)), .02, 60) : 1;
  }
  // Self-levelling, part 2: render the reference phrase once through the real sample voices (22 kHz mono,
  // offline, a few tens of ms) and scale the set so it measures exactly the reference level.
  async function calibrateSet(set) {
    const OAC = typeof window !== 'undefined' && (window.OfflineAudioContext || window.webkitOfflineAudioContext);
    if (!OAC) return;
    try {
      // The probe plays the set unscaled (no self-level, no manifest gain, no trim); the manifest gain
      // stays a deliberate trim on top of the result.
      const sr = 22050, c = new OAC(1, Math.ceil(sr * REFERENCE.seconds), sr), probe = { ...set, norm: 1, gain: 1 };
      const player = createPlayer(c, { ...sampleModel(set.id, [probe], [{ weight: 1 }], null, 'sample', set.id), level: 1 }, c.destination);
      playReference(player, isBassId(set.id));
      const buf = await new Promise((resolve, reject) => {
        c.oncomplete = e => resolve(e.renderedBuffer);
        const p = c.startRendering(); if (p && typeof p.then === 'function') p.then(resolve, reject);
      });
      player.disconnect();
      const level = balancedDb(buf.getChannelData(0), sr);
      if (Number.isFinite(level) && level > -100) set.norm = clamp(dbToGain(REFERENCE.balancedDb - level), .02, 60);
    } catch (e) { console.warn(`[instruments] could not level ${set.id}; using an estimate`, e); }
  }
  function buildSet(id, man, samples) {
    samples.sort((a, b) => a.midi - b.midi || a.vel - b.vel);
    const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? clamp(n, lo, hi) : d; };
    // The set levels itself (calibrateSet), so a manifest's own loudness estimate ("gain") is not
    // applied; "trim" (linear) is a deliberate adjustment on top of the self-levelling.
    const set = {
      id, name: String(man.name || id), samples, sustained: !!man.sustained,
      release: num(man.release, .5, .02, 8), attack: num(man.attack, .004, .001, .5), gain: num(man.trim, 1, .01, 20),
      license: man.license || '', attribution: man.attribution || '', source: man.source || '',
    };
    set.norm = autoNorm(set, isBassId(id));
    return set;
  }
  const sets = new Map(), models = new Map();
  function loadSet(id, ctx) {
    const hit = sets.get(id);
    if (hit) { hit.used = Date.now(); return hit.promise; }
    const entry = { used: Date.now(), set: null };
    entry.promise = (async () => {
      const ids = await loadIndex();
      if (!ids || !ids.has(id)) return null;
      const dir = baseUrl() + encodeURIComponent(id) + '/';
      const res = await fetch(dir + 'manifest.json');
      if (!res.ok) throw new Error(`${id}/manifest.json: HTTP ${res.status}`);
      const man = await res.json();
      const list = (Array.isArray(man?.samples) ? man.samples : []).filter(s => s && s.file && Number.isFinite(Number(s.midi)));
      if (!list.length) throw new Error(`${id}/manifest.json lists no samples`);
      const loaded = await Promise.allSettled(list.map(async s => {
        const r = await fetch(new URL(String(s.file), dir).href);
        if (!r.ok) throw new Error(`${id}/${s.file}: HTTP ${r.status}`);
        return prepSample(s, await decode(ctx, await r.arrayBuffer()), Number(man.sampleRate) || 44100);
      }));
      const samples = loaded.filter(x => x.status === 'fulfilled').map(x => x.value);
      if (!samples.length) throw loaded.find(x => x.status === 'rejected')?.reason || new Error(`${id}: no samples decoded`);
      if (samples.length < list.length) console.warn(`[instruments] ${id}: ${list.length - samples.length} of ${list.length} samples failed to load`);
      const set = buildSet(id, man, samples);
      await calibrateSet(set);
      return (entry.set = set);
    })();
    const forget = () => { if (sets.get(id) === entry) sets.delete(id); };
    entry.promise.then(set => { if (!set) forget(); }, forget);
    sets.set(id, entry);
    if (sets.size > MAX_SETS) {
      // Least recently used sets are dropped with the models built on them; players that already
      // exist keep their buffers until they are discarded.
      const idle = [...sets.entries()].filter(([, e]) => e.set).sort((a, b) => a[1].used - b[1].used);
      while (sets.size > MAX_SETS && idle.length) {
        const [gone, e] = idle.shift();
        sets.delete(gone);
        for (const [mid, m] of models) if (m.value?.sets?.includes(e.set)) models.delete(mid);
      }
    }
    return entry.promise;
  }
  function trySet(id, ctx) {
    return loadSet(id, ctx).catch(e => { console.warn(`[instruments] ${id} sample set unavailable`, e); return null; });
  }

  // ---------------------------------------------------------------------------------------------
  // Models: everything a player needs to make a sound (sample sets are shared, players are not)
  // ---------------------------------------------------------------------------------------------
  function sampleModel(id, setList, layers, fxName, kind, from) {
    const fx = SAMPLE_FX[fxName] || {}, first = setList[0];
    const levelDb = kind === 'sample' ? (LEVEL_DB[id] ?? 0) : kind === 'layered' ? LAYER_LEVEL_DB : (fx.levelDb ?? 0);
    return {
      id, kind, from, sets: setList, layers, voice: sampleVoice, chain: CHAINS[fx.chain] || null,
      attack: fx.attack ?? first.attack, release: fx.release ?? first.release, maxLen: fx.maxLen || null, palm: !!fx.palm,
      maxVoices: 28, retrigger: .08, level: dbToGain(levelDb),
    };
  }
  function synthModel(id, name) {
    const d = SYNTHS[name];
    return {
      id, kind: 'synth', from: name, synth: d, voice: synthVoice, chain: CHAINS[d.chain] || null,
      attack: d.amp.attack, release: d.amp.release, maxLen: null, glide: d.glide || null,
      // leadDb: lead sounds sit a little above the level every other sound is matched to.
      maxVoices: d.maxVoices || 12, retrigger: Math.max(.06, Math.min(.3, d.amp.attack)), level: dbToGain((d.levelDb ?? 0) + (d.leadDb || 0)),
    };
  }
  async function resolve(id, ctx) {
    const def = DEFS[id];
    if (def?.alias) { const m = await resolve(def.alias, ctx); return m && { ...m, id, aliasOf: def.alias, level: m.level * dbToGain(ALIAS_LEVEL_DB[id] ?? 0) }; }
    if (def?.synth) return synthModel(id, def.synth);
    const own = await trySet(id, ctx);
    if (own) return sampleModel(id, [own], [{ weight: 1 }], null, 'sample', id);
    if (def?.derive) {
      const base = await trySet(def.derive[0], ctx);
      if (base) return sampleModel(id, [base], [{ weight: 1 }], def.derive[1], 'derived', def.derive[0]);
    }
    if (def?.layer) {
      const found = (await Promise.all(def.layer.map(x => trySet(x, ctx)))).map((s, i) => s && { s, L: BRASS_LAYERS[i] }).filter(Boolean);
      if (found.length >= 2) return sampleModel(id, found.map(x => x.s), found.map(x => x.L), null, 'layered', found.map(x => x.s.id).join('+'));
    }
    if (def?.fallbackSynth) return synthModel(id, def.fallbackSynth);
    return null;
  }

  // ---------------------------------------------------------------------------------------------
  // Voices
  // ---------------------------------------------------------------------------------------------
  // Graph per note: sources -> [voice filters] -> env (attack/decay) -> rel (scheduled note-off)
  //   -> out (forced stops: steal, retrigger, stop()) -> player chain. Each gain has a single job, so a
  // later stop never has to cancel a ramp that is already running; every fade ends at true zero.
  function sampleVoice(ctx, P, model, n, v) {
    let picks = [];
    model.sets.forEach((set, i) => { const s = pickSample(set, n.midi, n.vel); if (s) picks.push({ set, s, L: model.layers[i] || {} }); });
    if (picks.length > 1) {
      // A stacked section only uses the instruments whose range covers the note.
      const near = picks.filter(p => Math.abs(p.s.midi - n.midi) <= 6);
      picks = near.length ? near : [picks.reduce((a, b) => Math.abs(a.s.midi - n.midi) <= Math.abs(b.s.midi - n.midi) ? a : b)];
    }
    // Each layer: rate for the pitch, loop points (seconds) when the sample has valid ones, and the
    // time its recording runs out. The longest-sounding layer goes first (its source ends the voice).
    const layers = picks.map(({ set, s, L }) => {
      const rate = Math.pow(2, (n.midi - s.midi + (s.tune + (L.cents || 0)) / 100) / 12), at = n.when + (L.delay || 0), looped = s.loopEnd != null;
      return { set, s, L, rate, at, looped, end: looped ? Infinity : at + (s.buffer.duration - s.offset) / rate };
    }).sort((a, b) => b.end - a.end);
    const bufEnd = layers[0].end;
    for (const { set, s, L, rate, at, looped, end } of layers) {
      const level = set.norm * set.gain * s.gain * (L.weight ?? 1), src = ctx.createBufferSource(), g = gainNode(ctx, level);
      src.buffer = s.buffer; src.playbackRate.value = rate;
      if (looped) { src.loop = true; src.loopStart = s.loopStart; src.loopEnd = s.loopEnd; }
      src.connect(g); g.connect(v.env); v.nodes.push(g); v.sources.push(src);
      src.start(at, s.offset);
      if (end < bufEnd) {
        // A layer whose recording ends before the voice does fades out on its own, to true zero.
        const stop = end - .003, fade = Math.min(.25, Math.max(.01, (stop - at) * .3));
        g.gain.setValueAtTime(level, stop - TAIL - fade); g.gain.exponentialRampToValueAtTime(level * FLOOR, stop - TAIL); g.gain.linearRampToValueAtTime(0, stop);
      }
    }
    const A = n.attack ?? model.attack, g = v.env.gain, t = n.when;
    g.setValueAtTime(0, t); g.linearRampToValueAtTime(n.gain, t + A);
    if (model.palm) { g.setTargetAtTime(n.gain * .55, t + A, .025); g.setTargetAtTime(0, t + A + .08, .24); } // palm mute: thump, then a short body
    // Note-off; an unlooped recording is faded out before its last sample so a truncated tail never clicks.
    let relAt = n.duration != null ? t + n.duration : Infinity, len = n.release;
    if (bufEnd < Infinity) {
      const end = bufEnd - TAIL - .003, fade = Math.min(len, .25, Math.max(.01, (end - t) * .3));
      if (relAt + len > end) { if (relAt > end - fade) { relAt = end - fade; len = fade; } else len = end - relAt; }
    }
    if (relAt < Infinity) P.release(v, Math.max(t + .001, relAt), Math.max(.005, len));
  }
  function pitchCurve(spec, blip, seconds, rateMul, phase) {
    const rate = spec ? spec.rate * rateMul : 1, pts = Math.min(4096, Math.ceil(seconds * Math.max(rate * 24, 60)) + 2);
    const c = new Float32Array(pts);
    for (let i = 0; i < pts; i++) {
      const tt = i / (pts - 1) * seconds;
      let cents = 0;
      if (spec) cents += spec.depth * clamp((tt - spec.delay) / spec.fade, 0, 1) * Math.sin(2 * Math.PI * rate * tt + phase);
      if (blip) cents += blip.cents * Math.exp(-tt / blip.time);
      c[i] = cents;
    }
    return c;
  }
  function synthVoice(ctx, P, model, n, v) {
    const d = model.synth, R = resources(ctx), shift = 12 * (d.octave || 0), f = mtof(n.midi + shift), t = n.when, nyq = ctx.sampleRate * .45, pitched = [];
    const api = {
      f, t, nyq, midi: n.midi + shift, vel: n.vel / 127, ctx,
      osc(type, ratio = 1, cents = 0) {
        const o = ctx.createOscillator();
        if (typeof type === 'string') o.type = type; else o.setPeriodicWave(type);
        o._ratio = ratio * Math.pow(2, cents / 1200);
        o.frequency.value = clamp(f * o._ratio, 1, nyq);
        pitched.push(o); v.sources.push(o);
        return o;
      },
      gain(x = 1) { const g = gainNode(ctx, x); v.nodes.push(g); return g; },
      filter(type, freq, q, gainDb) { const b = biquad(ctx, type, freq, q, gainDb); v.nodes.push(b); return b; },
      noise() { const s = ctx.createBufferSource(); s.buffer = R.noise(); s.loop = true; s._offset = Math.random() * 1.5; v.sources.push(s); return s; },
      oneShotNoise(at, seconds) { const s = ctx.createBufferSource(); s.buffer = R.noise(); s.start(at, Math.random() * 1.5); s.stop(at + seconds); v.nodes.push(s); return s; },
      wave: name => R.wave(name),
    };
    d.build(api).connect(v.env);
    if (n.glideFrom != null && model.glide) {
      const from = mtof(n.glideFrom + shift);
      for (const o of pitched) {
        o.frequency.setValueAtTime(clamp(from * o._ratio, 1, nyq), t);
        o.frequency.exponentialRampToValueAtTime(clamp(f * o._ratio, 1, nyq), t + model.glide.time);
      }
    }
    if (d.vib || d.blip) {
      const seconds = Math.min(12, n.duration != null ? n.duration + n.release + .05 : 8), spread = d.vib?.spread || 0, seed = Math.random() * 6.283;
      const shared = spread ? null : pitchCurve(d.vib, d.blip, seconds, 1, seed);
      pitched.forEach((o, i) => o.detune.setValueCurveAtTime(shared || pitchCurve(d.vib, d.blip, seconds, 1 + spread * [0, 1, -.8][i % 3], seed + i * 2.1), t, seconds));
    }
    for (const s of v.sources) s.start(t, s._offset || 0);
    const a = d.amp, ks = a.keyscale ? Math.pow(2, -(n.midi - 60) / 24) : 1, g = v.env.gain;
    const peak = n.gain * (d.peak ?? .3) * (d.velAmp ? 1 - d.velAmp + d.velAmp * (n.vel / 127) : 1);
    const A = n.attack ?? (n.glideFrom != null ? Math.min(a.attack, .012) : a.attack);
    g.setValueAtTime(0, t);
    if (a.curve === 'exp') g.setTargetAtTime(peak, t, A / 3);
    else {
      g.linearRampToValueAtTime(peak, t + A);
      if (a.decay) g.setTargetAtTime(peak * (a.sustain ?? 0), t + A, a.decay * ks);
      if (a.decay2) g.setTargetAtTime(peak * (a.sustain2 ?? 0), t + A + a.decay2At, a.decay2 * ks);
    }
    if (n.duration != null) P.release(v, t + n.duration, n.release);
  }

  // ---------------------------------------------------------------------------------------------
  // Players
  // ---------------------------------------------------------------------------------------------
  function createPlayer(ctx, model, destination) {
    const out = gainNode(ctx, model.level), chain = model.chain ? model.chain(ctx) : null;
    const input = chain ? chain.input : out;
    if (chain) chain.output.connect(out);
    let voices = [], last = null, disposed = false;

    function setEnd(v, end) { v.endAt = end; for (const s of v.sources) try { s.stop(end + .002); } catch {} }
    // Scheduled note-off: rel gain has no events before this, so the ramp starts exactly from 1.
    function release(v, at, len) {
      const g = v.rel.gain;
      g.setValueAtTime(1, at); g.exponentialRampToValueAtTime(FLOOR, at + len); g.linearRampToValueAtTime(0, at + len + TAIL);
      v.relStart = at; setEnd(v, at + len + TAIL);
    }
    // Forced fade on the voice's own output gain (steal, retrigger, stop() before the scheduled note-off).
    function cut(v, at, len) {
      if (v.done) return;
      at = Math.max(at, ctx.currentTime);
      const g = v.out.gain;
      if (at <= v.start) { // never sounded
        g.cancelScheduledValues(0); g.setValueAtTime(0, Math.max(ctx.currentTime, v.start - .001));
        v.cutAt = at; setEnd(v, v.start + .001); return;
      }
      const end = at + len + TAIL;
      if (end >= v.endAt || (v.cutAt != null && v.cutAt <= at)) return;
      if (v.cutAt != null) g.cancelScheduledValues(at);
      g.setValueAtTime(1, at); g.exponentialRampToValueAtTime(FLOOR, at + len); g.linearRampToValueAtTime(0, end);
      v.cutAt = at; setEnd(v, end);
    }
    function stopVoice(v, when) {
      const at = Math.max(ctx.currentTime, Number(when) || 0);
      if (v.done || at >= v.relStart) return;
      if (at <= v.start) cut(v, at, .002);
      else if (v.relStart === Infinity && v.cutAt == null) release(v, at, v.release);
      else cut(v, at, v.release);
      chain?.touch?.(at, v.endAt + .3);
    }
    function cleanup(v) {
      if (v.done) return;
      v.done = true;
      for (const nd of [...v.sources, ...v.nodes, v.env, v.rel, v.out]) try { nd.disconnect(); } catch {}
      voices = voices.filter(x => x !== v);
      if (last?.v === v) last = null;
      if (disposed && !voices.length) try { out.disconnect(); } catch {}
    }
    const P = { release };

    function play(note, when, opts) {
      if (disposed) return undefined;
      const m0 = toMidi(note);
      if (m0 == null) { console.warn(`[instruments] Unknown note ${note}`); return undefined; }
      opts = opts || {};
      const now = ctx.currentTime, t = Math.max(now, Number(when) || 0);
      const gain = Number.isFinite(Number(opts.gain)) ? Math.max(0, Number(opts.gain)) : 1;
      const vel = Number.isFinite(Number(opts.velocity)) ? clamp(Number(opts.velocity), 1, 127) : clamp(Math.round(gain * 100), 1, 127);
      const midi = m0 + (Number(opts.cents) || 0) / 100, key = Math.round(midi);
      let duration = Number(opts.duration) > 0 ? Number(opts.duration) : null;
      if (model.maxLen) duration = Math.min(duration ?? model.maxLen, model.maxLen);
      const rel = Number(opts.release) > 0 ? clamp(Number(opts.release), .01, 10) : model.release;
      const attack = Number(opts.attack) > 0 ? clamp(Number(opts.attack), .001, 5) : null;
      voices = voices.filter(x => !x.done && x.endAt > now - .05);
      // Portamento: a note that follows the previous one (no chord) glides from it, legato.
      let glideFrom = null;
      if (model.glide && last && !last.v.done && t - last.start > .015 && t <= Math.min(last.v.relStart, last.v.endAt) + model.glide.gap) {
        glideFrom = last.midi; cut(last.v, t, .045);
      }
      // The same key again replaces the ringing note (a quick crossfade, not a pile-up).
      for (const o of voices) if (o.key === key && o.start <= t + 1e-4 && o.endAt > t && o.relStart > t) cut(o, t, model.retrigger);
      // Polyphony cap: steal released voices first, then the oldest, each with a short fade.
      const sounding = voices.filter(o => o.start <= t + 1e-4 && o.endAt > t && !(o.cutAt != null && o.cutAt <= t));
      sounding.sort((a, b) => (Number(a.relStart > t) - Number(b.relStart > t)) || (a.start - b.start));
      while (sounding.length >= model.maxVoices) cut(sounding.shift(), t, STEAL_FADE);

      const v = { env: gainNode(ctx, 0), rel: gainNode(ctx), out: gainNode(ctx), sources: [], nodes: [], start: t, key, release: rel, relStart: Infinity, endAt: Infinity, cutAt: null, done: false };
      v.env.connect(v.rel); v.rel.connect(v.out); v.out.connect(input);
      try {
        model.voice(ctx, P, model, { midi, when: t, duration, gain, vel, release: rel, attack, glideFrom }, v);
        if (!v.sources.length) throw new Error('voice made no sound');
      } catch (e) { cleanup(v); throw e; }
      v.sources[0].addEventListener('ended', () => cleanup(v));
      const node = v.out;
      node.source = v.sources[0];
      node.stop = when2 => stopVoice(v, when2);
      node.midi = m0; node.id = ++voiceIds;
      voices.push(v); last = { midi, start: t, v };
      chain?.touch?.(t, (v.endAt < Infinity ? v.endAt : t + 30) + .3);
      return node;
    }
    const player = {
      engine: 'crp-instruments', version: VERSION, id: model.id, name: model.id, kind: model.kind, from: model.from, context: ctx, out,
      play, start: play,
      stop(when) { const ids = []; for (const v of [...voices]) { stopVoice(v, when); ids.push(v.out.id); } return ids; },
      connect(dest) { out.connect(dest); return player; },
      disconnect(...a) { try { out.disconnect(...a); } catch {} return player; },
      createPlayer: (c, dest) => createPlayer(c, model, dest),
      voiceCount: () => voices.filter(v => !v.done).length,
      dispose() { disposed = true; for (const v of [...voices]) cut(v, ctx.currentTime, .02); if (!voices.length) try { out.disconnect(); } catch {} },
    };
    if (destination) player.connect(destination);
    return player;
  }
  let voiceIds = 0;

  // ---------------------------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------------------------
  // Resolved models by sound id ({promise, value}); a sound with nothing to play is not cached, so a set
  // delivered or reachable later is picked up by the next load.
  function model(id, ctx) {
    const hit = models.get(id);
    if (hit) return hit.promise;
    const entry = { value: null };
    entry.promise = resolve(id, ctx).then(m => { if (m) entry.value = m; else if (models.get(id) === entry) models.delete(id); return m; },
      e => { if (models.get(id) === entry) models.delete(id); throw e; });
    models.set(id, entry);
    return entry.promise;
  }
  async function load(ctx, soundId, destination) {
    const id = String(soundId || '');
    if (config.disabled) throw unavailable(id, 'engine disabled');
    if (!ctx || typeof ctx.createGain !== 'function') throw new Error('CRPInstruments.load needs an audio context');
    const m = await model(id, ctx);
    if (!m) throw unavailable(id, 'no sample set delivered');
    return createPlayer(ctx, m, destination || ctx.destination);
  }
  // Synchronous best guess of whether load() will serve the sound (null: not known yet).
  function provides(id) {
    if (config.disabled) return false;
    const def = DEFS[id];
    if (def?.alias) return provides(def.alias);
    if (def?.synth || def?.fallbackSynth) return true;
    const ids = indexState?.ok ? indexState.ids : null;
    if (!ids) return null;
    if (ids.has(id)) return true;
    if (def?.derive && ids.has(def.derive[0])) return true;
    if (def?.layer) return def.layer.filter(x => ids.has(x)).length >= 2;
    return false;
  }
  async function describe(id, ctx) {
    const def = DEFS[id];
    if (config.disabled) return { id, kind: 'soundfont' };
    const c = ctx || new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 128, 44100);
    const m = await model(id, c).catch(() => null);
    return m ? { id, kind: m.kind, from: m.from, aliasOf: m.aliasOf || def?.alias || null, sets: (m.sets || []).map(s => ({ id: s.id, samples: s.samples.length, norm: s.norm, license: s.license })) } : { id, kind: 'soundfont' };
  }
  function configure(opts = {}) {
    const prev = config.basePath;
    if (opts.basePath != null) config.basePath = String(opts.basePath);
    if (opts.disabled != null) config.disabled = !!opts.disabled;
    if (config.basePath !== prev) { indexState = null; sets.clear(); models.clear(); }
    return { ...config };
  }
  window.CRPInstruments = {
    version: VERSION, busGain: 1,
    load, provides, describe, configure, toMidi, gatedDb, phoneWeighted, balancedDb,
    reference: REFERENCE, ids: Object.keys(DEFS),
    get basePath() { return baseUrl(); },
    get disabled() { return config.disabled; },
  };
})();
