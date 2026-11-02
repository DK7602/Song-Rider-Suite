// Music effects for Baby DAW and Track Master: per-track and per-clip effects for chord/note parts,
// lead/bass parts and the drums, and one set of song effects for the whole mix.
//
// Pure Web Audio graph builders. They work on any BaseAudioContext (the live AudioContext and the
// OfflineAudioContext used by WAV export), are deterministic, set every parameter when they are built
// (an offline render can finish before any later message arrives) and allocate nothing per sample.
// An effect that is Off is not in the graph: each effect sits in a "slot" that holds either a plain
// pass-through gain or the effect's few nodes, and changing a preset swaps them with a 30 ms crossfade.
//
//   Track / clip:  input → EQ → drive → compression → modulation → pan → duck → trim → destination
//                                                                               ↳ reverb send, delay send
//   Song:          input (+ reverb return + delay return) → EQ → glue → width → destination
//                  reverbSend → room convolver → return     delaySend → tempo delay (filtered feedback) → return
//
// Pump: the song's kicks duck every track that has "Duck to kick" on. The drums report each kick's time
// (live from Beat Maker's scheduler, in export from the region data) and every duck gain gets the same
// scheduled envelope, so playback and export pump identically.
(() => {
  'use strict';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const db = g => 20 * Math.log10(Math.max(1e-9, g));
  const fromDb = d => Math.pow(10, d / 20);
  // Every level-dependent stage (drive, compression, glue) first scales the material so its nominal
  // loudness sits at REF_RMS (-20 dBFS RMS), then scales back, so a preset behaves the same on a quiet
  // drum bus and a loud bass line. `level` (the nominal gated RMS at the stage, linear) comes from the
  // caller: Baby DAW measures it per kind of track (CRPMusicFx.LEVELS).
  const REF_RMS = .1, CREST = 8; // CREST: nominal peak over RMS (18 dB), where the drive curves start to bend
  const LEVELS = { chord: fromDb(-29), lead: fromDb(-24), drums: fromDb(-41), song: fromDb(-28) };
  const XFADE = .03, PREROLL = .01; // seconds: crossfade when an effect is switched on, off or to another preset

  // ---- Presets ---------------------------------------------------------------------------------------
  // EQ: [type, frequency, Q, gain dB]. Amount scales every gain; a high-pass or low-pass cutoff moves from
  // the edge of hearing (Amount 0) to the preset's cutoff (Amount 100). `trim` (dB, scaled by Amount)
  // makes up for presets that take a lot of energy away.
  const EQ_PRESETS = {
    warm: { bands: [['lowshelf', 200, null, 3], ['peaking', 2800, .9, -1.5], ['highshelf', 7500, null, -3.5]] },
    bright: { bands: [['lowshelf', 160, null, -1.5], ['peaking', 3200, .9, 2], ['highshelf', 6500, null, 5]] },
    scoop: { bands: [['lowshelf', 110, null, 4.5], ['peaking', 750, .7, -5.5], ['highshelf', 7000, null, 4.5]], trim: 2 },
    mid: { bands: [['lowshelf', 120, null, -2], ['peaking', 1100, .8, 5], ['highshelf', 9000, null, -2]], trim: -1.5 },
    thin: { bands: [['highpass', 300, .75], ['peaking', 2800, 1, 1.5]], trim: .5 },
    dark: { bands: [['lowpass', 2400, .75], ['peaking', 350, .9, 1.5]], trim: -1 },
    telephone: { bands: [['highpass', 480, .9], ['lowpass', 3300, .9], ['peaking', 1500, .8, 4]], trim: -.5 },
  };
  const EQ_LABELS = { off: 'Off', warm: 'Warm', bright: 'Bright', scoop: 'Scoop (smile)', mid: 'Mid push', thin: 'Thin (low cut)', dark: 'Dark (high cut)', telephone: 'Telephone' };
  // Compression. Chrome's DynamicsCompressorNode adds its own make-up gain (0.6 × the gain reduction it
  // would apply at full scale); `makeup` brings each preset back to the uncompressed loudness. Thresholds
  // are relative to the normalised loudness (-20 dBFS RMS, so Light only catches the peaks). Measured on
  // piano chords, strummed guitar, a piano melody, a bass line and a drum loop at their nominal levels:
  // every preset is within ±1.2 dB of Off on all five (gated loudness).
  const COMP_PRESETS = {
    light: { threshold: -8, ratio: 2, knee: 8, attack: .012, release: .22, makeup: .892 },
    medium: { threshold: -12, ratio: 3, knee: 10, attack: .01, release: .25, makeup: .801 },
    heavy: { threshold: -16, ratio: 6, knee: 14, attack: .004, release: .18, makeup: .742 },
    punch: { threshold: -14, ratio: 4, knee: 10, attack: .03, release: .15, makeup: .716 },
  };
  const COMP_LABELS = { off: 'Off', light: 'Light', medium: 'Medium', heavy: 'Heavy', punch: 'Punch (drums, plucks)' };
  // Song glue: slower and gentler, on the whole mix (normalised the same way, from the mix's nominal
  // loudness). Make-up measured on a full mix (piano chords, bass line, drums): within ±0.1 dB of Off;
  // a song of just one instrument lands within ±1.7 dB.
  const GLUE_PRESETS = {
    light: { threshold: -10, ratio: 1.6, knee: 10, attack: .02, release: .25, makeup: .893 },
    medium: { threshold: -13, ratio: 2, knee: 10, attack: .015, release: .22, makeup: .8 },
    heavy: { threshold: -17, ratio: 3, knee: 10, attack: .01, release: .18, makeup: .69 },
  };
  const GLUE_LABELS = { off: 'Off', light: 'Light', medium: 'Medium', heavy: 'Heavy' };
  // Drive: an oversampled waveshaper. Amount sets the gain into the curve (min..max, exponential); the
  // output is scaled back by the curve's computed loss (plus `trim` dB at Amount 100, measured) so loudness
  // stays about level; a tone low-pass tames the fizz and a 20 Hz high-pass removes the offset the
  // asymmetric Warm curve makes.
  const DRIVE_PRESETS = {
    warm: { min: 1, max: 4, tone: 7500, curve: 'warm', oversample: '2x', trim: -.3 },
    crunch: { min: 2, max: 10, tone: 5200, curve: 'crunch', oversample: '4x', trim: -.6 },
    fuzz: { min: 3, max: 14, tone: 3600, curve: 'fuzz', oversample: '4x', trim: -.4 },
  };
  const DRIVE_LABELS = { off: 'Off', warm: 'Warm', crunch: 'Crunch', fuzz: 'Fuzz' };
  // Modulation. Speed 0..100 maps exponentially onto each effect's rate range (Hz); Amount sets depth/mix.
  const MOD_RATES = { chorus: [.15, 3], phaser: [.1, 4], flanger: [.05, 2], tremolo: [1, 14], autopan: [.1, 6] };
  const MOD_LABELS = { off: 'Off', chorus: 'Chorus', phaser: 'Phaser', flanger: 'Flanger', tremolo: 'Tremolo', autopan: 'Auto-pan' };
  // Shared song reverb rooms: decay (RT60, s), pre-delay, how the highs die away, early reflections.
  const ROOMS = {
    room: { rt: .8, pre: .008, hiStart: 9000, hiEnd: 3500, er: 6, erSpan: .035 },
    hall: { rt: 1.9, pre: .02, hiStart: 8000, hiEnd: 2200, er: 8, erSpan: .07 },
    plate: { rt: 1.5, pre: .002, hiStart: 12000, hiEnd: 6000, er: 0, erSpan: 0 },
    large: { rt: 3.2, pre: .03, hiStart: 7500, hiEnd: 1800, er: 9, erSpan: .1 },
  };
  const ROOM_LABELS = { room: 'Room', hall: 'Hall', plate: 'Plate', large: 'Large Hall' };
  // Every room impulse has the same energy, so the rooms differ in length and colour, not loudness:
  // with a track's send and the song's reverb level at 100 %, the reverb sits ~8 dB under the dry sound.
  const REVERB_WET = .4;
  // Shared song delay: note values in beats (tempo-synced) and the level of the returned echoes.
  const DELAY_TIMES = { '1/8': .5, '1/8d': .75, '1/4': 1, '1/2': 2 };
  const DELAY_LABELS = { '1/8': '1/8', '1/8d': 'Dotted 1/8', '1/4': '1/4', '1/2': '1/2' };
  const DELAY_RETURN = .6, DELAY_MAX_SEC = 3.2, FEEDBACK_MAX = .85;
  // Pump: depth in dB at each kick and how long (in beats, so it follows the tempo) the level takes to
  // come back. The duck falls in PUMP_ATTACK seconds, holds briefly and swells back (smoothstep in dB).
  const PUMP_PRESETS = { subtle: { depth: -3, release: .35 }, medium: { depth: -6, release: .5 }, heavy: { depth: -11, release: .7 } };
  const PUMP_LABELS = { off: 'Off', subtle: 'Subtle', medium: 'Medium', heavy: 'Heavy' };
  const PUMP_ATTACK = .004, PUMP_STEPS = 14;

  const TRACK_DEFAULT = Object.freeze({ eq: 'off', eqAmount: 100, comp: 'off', drive: 'off', driveAmount: 50, mod: 'off', modAmount: 50, modSpeed: 40, pan: 0, reverb: 0, delay: 0, duck: false, bypass: false });
  const SONG_DEFAULT = Object.freeze({ eq: 'off', eqAmount: 100, glue: 'off', room: 'hall', reverb: 80, delay: '1/8', feedback: 35, width: 0, pump: 'off' });
  const pick = (v, table, d) => (v === 'off' || Object.prototype.hasOwnProperty.call(table, v)) ? v : d;

  // A track's (or clip's) settings with every field present and in range. `duck` is the default for
  // "Duck to kick" (on for chord/lead tracks); clip FX carry no duck/bypass of their own.
  function normalizeTrackFx(obj, { duck = false, clip = false } = {}) {
    const o = obj && typeof obj === 'object' ? obj : {};
    const f = {
      eq: pick(o.eq, EQ_PRESETS, 'off'), eqAmount: clamp(Math.round(num(o.eqAmount, TRACK_DEFAULT.eqAmount)), 0, 100),
      comp: pick(o.comp, COMP_PRESETS, 'off'),
      drive: pick(o.drive, DRIVE_PRESETS, 'off'), driveAmount: clamp(Math.round(num(o.driveAmount, TRACK_DEFAULT.driveAmount)), 0, 100),
      mod: pick(o.mod, MOD_RATES, 'off'), modAmount: clamp(Math.round(num(o.modAmount, TRACK_DEFAULT.modAmount)), 0, 100), modSpeed: clamp(Math.round(num(o.modSpeed, TRACK_DEFAULT.modSpeed)), 0, 100),
      pan: clamp(Math.round(num(o.pan, 0)), -100, 100),
      reverb: clamp(Math.round(num(o.reverb, 0)), 0, 100), delay: clamp(Math.round(num(o.delay, 0)), 0, 100),
    };
    if (!clip) { f.duck = typeof o.duck === 'boolean' ? o.duck : !!duck; f.bypass = o.bypass === true; }
    return f;
  }
  function normalizeSongFx(obj) {
    const o = obj && typeof obj === 'object' ? obj : {};
    return {
      eq: pick(o.eq, EQ_PRESETS, 'off'), eqAmount: clamp(Math.round(num(o.eqAmount, SONG_DEFAULT.eqAmount)), 0, 100),
      glue: pick(o.glue, GLUE_PRESETS, 'off'),
      room: Object.prototype.hasOwnProperty.call(ROOMS, o.room) ? o.room : SONG_DEFAULT.room, reverb: clamp(Math.round(num(o.reverb, SONG_DEFAULT.reverb)), 0, 100),
      delay: Object.prototype.hasOwnProperty.call(DELAY_TIMES, o.delay) ? o.delay : SONG_DEFAULT.delay, feedback: clamp(Math.round(num(o.feedback, SONG_DEFAULT.feedback)), 0, 100),
      width: clamp(Math.round(num(o.width, 0)), -100, 100),
      pump: pick(o.pump, PUMP_PRESETS, 'off'),
    };
  }
  // True when the settings change nothing: every effect Off, centred, no sends (track/clip), or no song
  // EQ/glue/width/pump (song; the reverb room and delay time only matter once a track sends to them).
  function isDefault(fx) {
    if (!fx || typeof fx !== 'object') return true;
    if ('glue' in fx || 'pump' in fx || 'width' in fx) { const s = normalizeSongFx(fx); return s.eq === 'off' && s.glue === 'off' && s.width === 0 && s.pump === 'off'; }
    const t = normalizeTrackFx(fx, { clip: true });
    return t.eq === 'off' && t.comp === 'off' && t.drive === 'off' && t.mod === 'off' && t.pan === 0 && t.reverb === 0 && t.delay === 0;
  }
  // What actually plays: Bypass switches a track's effects and sends off (pan and duck stay).
  function effectiveTrackFx(fx) {
    const f = normalizeTrackFx(fx, { duck: fx?.duck === true });
    if (!f.bypass) return f;
    return { ...f, eq: 'off', comp: 'off', drive: 'off', mod: 'off', reverb: 0, delay: 0 };
  }
  function modRate(type, speed) { const r = MOD_RATES[type]; if (!r) return 0; return r[0] * Math.pow(r[1] / r[0], clamp(num(speed, 40), 0, 100) / 100); }
  function delaySeconds(note, bpm) { return Math.min(DELAY_MAX_SEC, (DELAY_TIMES[note] || .5) * 60 / clamp(num(bpm, 92), 40, 240)); }
  function driveGain(preset, amount) { const D = DRIVE_PRESETS[preset]; return D ? D.min * Math.pow(D.max / D.min, clamp(num(amount, 50), 0, 100) / 100) : 1; }

  // ---- Small helpers ---------------------------------------------------------------------------------
  function gain(ctx, value = 1) { const g = ctx.createGain(); g.gain.value = value; return g; }
  function biquad(ctx, type, f, q, g) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q != null) b.Q.value = q; if (g != null) b.gain.value = g; return b; }
  // Up-mixes mono to stereo ("speakers": L = R = mono) so a panner or mid/side stage at its centre
  // setting leaves the sound exactly as it was.
  function stereo(ctx) { const g = gain(ctx); g.channelCount = 2; g.channelCountMode = 'explicit'; g.channelInterpretation = 'speakers'; return g; }
  function setParam(ctx, param, value, immediate, tc = .02) {
    if (immediate) { try { param.cancelScheduledValues(0); } catch {} param.value = value; return; }
    try { param.setTargetAtTime(value, ctx.currentTime, tc); } catch { param.value = value; }
  }
  function disconnectAll(nodes) { for (const n of nodes) { try { n?.stop?.(); } catch {} try { n?.disconnect(); } catch {} } }
  function lfo(ctx, hz) { const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = hz; o.start(ctx.currentTime); return o; }

  // A place in a chain for one effect: holds a pass-through or the effect, and swaps them with a short
  // crossfade (or at once when `immediate`, e.g. while an export graph is being built).
  function makeSlot(ctx, from, to) {
    let cur = null;
    // A gate starts silent unless it is mounted at once: a ramp scheduled at currentTime can begin a
    // sample late, and one sample of both paths at full level is a click.
    const mount = (stage, open) => {
      const gate = gain(ctx, open ? 1 : 0);
      if (stage) { from.connect(stage.entry); stage.exit.connect(gate); } else from.connect(gate);
      gate.connect(to);
      return { gate, stage };
    };
    const unmount = m => { if (!m) return; try { from.disconnect(m.stage ? m.stage.entry : m.gate); } catch {} disconnectAll([m.gate, ...(m.stage?.nodes || [])]); };
    const slot = {
      get stage() { return cur?.stage || null; },
      replace(stage, immediate) {
        const old = cur, next = mount(stage, immediate || !old);
        cur = next;
        if (!old) return;
        if (immediate) { unmount(old); return; }
        // The new effect runs silently for PREROLL first, so its filters and oversampler have settled
        // before it is heard.
        const at = ctx.currentTime + PREROLL;
        next.gate.gain.setValueAtTime(0, at); next.gate.gain.linearRampToValueAtTime(1, at + XFADE);
        try { old.gate.gain.cancelScheduledValues(ctx.currentTime); } catch {}
        old.gate.gain.setValueAtTime(1, at); old.gate.gain.linearRampToValueAtTime(0, at + XFADE);
        setTimeout(() => unmount(old), (PREROLL + XFADE) * 1000 + 80);
      },
      dispose() { unmount(cur); cur = null; },
    };
    slot.replace(null, true);
    return slot;
  }

  // ---- EQ --------------------------------------------------------------------------------------------
  function eqBandValues(band, amount) {
    const [type, f, q, g] = band, a = clamp(amount, 0, 100) / 100;
    if (type === 'highpass') return { f: 20 * Math.pow(f / 20, a), q, g: 0 };
    if (type === 'lowpass') return { f: 20000 * Math.pow(f / 20000, a), q, g: 0 };
    return { f, q, g: (g || 0) * a };
  }
  function eqStage(ctx, preset, amount) {
    const P = EQ_PRESETS[preset]; if (!P) return null;
    const filters = P.bands.map(b => { const v = eqBandValues(b, amount); return biquad(ctx, b[0], v.f, v.q, v.g); });
    const trim = gain(ctx, fromDb((P.trim || 0) * clamp(amount, 0, 100) / 100));
    filters.reduce((a, b) => { a.connect(b); return b; }).connect(trim);
    return {
      entry: filters[0], exit: trim, nodes: [...filters, trim], kind: preset,
      update(amt, immediate) {
        P.bands.forEach((b, i) => { const v = eqBandValues(b, amt); setParam(ctx, filters[i].frequency, v.f, immediate, .03); if (b[0] !== 'highpass' && b[0] !== 'lowpass') setParam(ctx, filters[i].gain, v.g, immediate, .03); });
        setParam(ctx, trim.gain, fromDb((P.trim || 0) * clamp(amt, 0, 100) / 100), immediate, .03);
      },
    };
  }

  // ---- Compression / glue ----------------------------------------------------------------------------
  function compStage(ctx, C, level) {
    if (!C) return null;
    const pre = gain(ctx, REF_RMS / level), comp = ctx.createDynamicsCompressor(), post = gain(ctx, C.makeup * level / REF_RMS);
    for (const k of ['threshold', 'ratio', 'knee', 'attack', 'release']) comp[k].value = C[k];
    pre.connect(comp); comp.connect(post);
    return { entry: pre, exit: post, nodes: [pre, comp, post] };
  }

  // ---- Drive -----------------------------------------------------------------------------------------
  // Curves over u (input × drive gain, in units of the nominal peak); the shaper sees u / RANGE.
  const CURVE_RANGE = 4, CURVE_POINTS = 8193, curves = new Map();
  const CURVE_FN = {
    // Soft, asymmetric (the negative side squashes sooner): mostly 2nd and 3rd harmonics.
    warm: u => u >= 0 ? Math.tanh(u) : Math.tanh(1.3 * u) / 1.3,
    // Sharper knee: an exponential soft clip.
    crunch: u => Math.sign(u) * (1 - Math.exp(-Math.abs(u))),
    // Nearly square: a smoothed hard clip.
    fuzz: u => u / Math.pow(1 + Math.pow(Math.abs(u), 8), 1 / 8),
  };
  function curveFor(name) {
    let c = curves.get(name); if (c) return c;
    const fn = CURVE_FN[name]; c = new Float32Array(CURVE_POINTS);
    for (let i = 0; i < CURVE_POINTS; i++) c[i] = fn((i / (CURVE_POINTS - 1) * 2 - 1) * CURVE_RANGE);
    curves.set(name, c); return c;
  }
  // Loudness lost (or gained) by the curve at drive gain g, measured on a decaying three-note chord that
  // peaks at the nominal level: the factor that brings the output back to the input's RMS.
  const driveComp = new Map();
  function driveCompensation(name, g) {
    const key = `${name}:${g.toFixed(4)}`; let c = driveComp.get(key); if (c) return c;
    const fn = CURVE_FN[name], N = 4096; let ein = 0, eout = 0;
    for (let i = 0; i < N; i++) {
      const t = i / N, x = (Math.sin(2 * Math.PI * 11 * t) + .8 * Math.sin(2 * Math.PI * 13.9 * t + 1) + .6 * Math.sin(2 * Math.PI * 16.5 * t + 2)) / 2.4 * Math.exp(-2.2 * t);
      const y = fn(clamp(x * g, -CURVE_RANGE, CURVE_RANGE)) / g;
      ein += x * x; eout += y * y;
    }
    c = Math.sqrt(ein / Math.max(1e-12, eout));
    if (driveComp.size > 512) driveComp.clear();
    driveComp.set(key, c); return c;
  }
  function driveLevels(preset, amount, level) {
    // Shaper input x = signal × pre, output f(x × RANGE) = f(u) with u = signal / (level × CREST) × g: the
    // nominal peak reaches u = g. Small signals pass at unity after the post gain (level × CREST / g); the
    // compensation restores the loudness the curve took.
    const D = DRIVE_PRESETS[preset], g = driveGain(preset, amount), pk = level * CREST;
    return { pre: g / (pk * CURVE_RANGE), post: pk / g * driveCompensation(D.curve, g) * fromDb(D.trim * clamp(num(amount, 50), 0, 100) / 100) };
  }
  function driveStage(ctx, preset, amount, level) {
    const D = DRIVE_PRESETS[preset]; if (!D) return null;
    const L = driveLevels(preset, amount, level);
    const pre = gain(ctx, L.pre), shaper = ctx.createWaveShaper(), dc = biquad(ctx, 'highpass', 20, .7), tone = biquad(ctx, 'lowpass', D.tone, .7), post = gain(ctx, L.post);
    shaper.curve = curveFor(D.curve); shaper.oversample = D.oversample;
    pre.connect(shaper); shaper.connect(dc); dc.connect(tone); tone.connect(post);
    return {
      entry: pre, exit: post, nodes: [pre, shaper, dc, tone, post], kind: preset,
      update(amt, immediate) { const v = driveLevels(preset, amt, level); setParam(ctx, pre.gain, v.pre, immediate, .03); setParam(ctx, post.gain, v.post, immediate, .03); },
    };
  }

  // ---- Modulation ------------------------------------------------------------------------------------
  function modStage(ctx, type, amount, speed) {
    if (!MOD_RATES[type]) return null;
    const osc = lfo(ctx, modRate(type, speed));
    const input = gain(ctx), output = gain(ctx), nodes = [input, output, osc];
    let update;
    if (type === 'chorus') {
      // Two delay lines swept in opposite directions, one per side: a wide, shimmering double.
      const dl = ctx.createDelay(.1), dr = ctx.createDelay(.1), dep = gain(ctx), depR = gain(ctx), merge = ctx.createChannelMerger(2), wet = gain(ctx), dry = gain(ctx), norm = gain(ctx);
      dl.delayTime.value = .018; dr.delayTime.value = .024;
      osc.connect(dep); dep.connect(dl.delayTime); osc.connect(depR); depR.connect(dr.delayTime);
      input.connect(dry); dry.connect(norm); input.connect(dl); input.connect(dr); dl.connect(merge, 0, 0); dr.connect(merge, 0, 1); merge.connect(wet); wet.connect(norm); norm.connect(output);
      nodes.push(dl, dr, dep, depR, merge, wet, dry, norm);
      update = (amt, spd, immediate) => {
        const x = clamp(amt, 0, 100) / 100, d = .0005 + .0035 * x;
        setParam(ctx, dep.gain, d, immediate); setParam(ctx, depR.gain, -d, immediate); setParam(ctx, wet.gain, .75 * x, immediate);
        setParam(ctx, norm.gain, 1 / (1 + .12 * x), immediate); setParam(ctx, osc.frequency, modRate(type, spd), immediate, .05);
      };
    } else if (type === 'flanger') {
      // One short delay swept between ~0.5 and ~5.5 ms with feedback: the jet-plane comb sweep.
      const d = ctx.createDelay(.05), dep = gain(ctx), fb = gain(ctx), wet = gain(ctx), dry = gain(ctx), norm = gain(ctx);
      d.delayTime.value = .003;
      osc.connect(dep); dep.connect(d.delayTime); input.connect(dry); input.connect(d); d.connect(fb); fb.connect(d); d.connect(wet); dry.connect(norm); wet.connect(norm); norm.connect(output);
      nodes.push(d, dep, fb, wet, dry, norm);
      update = (amt, spd, immediate) => {
        const x = clamp(amt, 0, 100) / 100;
        setParam(ctx, dep.gain, .0025 * (.3 + .7 * x), immediate); setParam(ctx, fb.gain, .6 * x, immediate); setParam(ctx, wet.gain, .5 + .4 * x, immediate);
        setParam(ctx, norm.gain, 1 / (1 + .45 * x), immediate); setParam(ctx, osc.frequency, modRate(type, spd), immediate, .05);
      };
    } else if (type === 'phaser') {
      // Four all-pass stages swept together; mixed with the dry sound they cut moving notches.
      const aps = [440, 880, 1760, 3520].map(f => biquad(ctx, 'allpass', f, .7)), deps = aps.map(() => gain(ctx)), wet = gain(ctx), dry = gain(ctx), norm = gain(ctx);
      aps.reduce((p, n) => { p.connect(n); return n; }); input.connect(aps[0]); aps[3].connect(wet); input.connect(dry); dry.connect(norm); wet.connect(norm); norm.connect(output);
      aps.forEach((ap, i) => { osc.connect(deps[i]); deps[i].connect(ap.frequency); });
      nodes.push(...aps, ...deps, wet, dry, norm);
      update = (amt, spd, immediate) => {
        const x = clamp(amt, 0, 100) / 100;
        aps.forEach((ap, i) => setParam(ctx, deps[i].gain, [440, 880, 1760, 3520][i] * .75 * (.25 + .75 * x), immediate));
        setParam(ctx, wet.gain, .4 + .6 * x, immediate); setParam(ctx, norm.gain, 1 / (1 + .32 * x), immediate); setParam(ctx, osc.frequency, modRate(type, spd), immediate, .05);
      };
    } else if (type === 'tremolo') {
      // Level swings by up to the whole level at the Speed rate; scaled so the average loudness holds.
      const vca = gain(ctx), dep = gain(ctx);
      input.connect(vca); vca.connect(output); osc.connect(dep); dep.connect(vca.gain);
      nodes.push(vca, dep);
      update = (amt, spd, immediate) => {
        const x = clamp(amt, 0, 100) / 100, c = 1 - x / 2, k = 1 / Math.sqrt(c * c + x * x / 8);
        setParam(ctx, vca.gain, c * k, immediate); setParam(ctx, dep.gain, x / 2 * k, immediate); setParam(ctx, osc.frequency, modRate(type, spd), immediate, .05);
      };
    } else {
      // Auto-pan: the sound (summed to mono) moves between the speakers at the Speed rate, equal-power,
      // ×√2 so the centre is exactly the unpanned level.
      const mono = gain(ctx, Math.SQRT2), pan = ctx.createStereoPanner(), dep = gain(ctx);
      mono.channelCount = 1; mono.channelCountMode = 'explicit'; mono.channelInterpretation = 'speakers';
      pan.pan.value = 0; input.connect(mono); mono.connect(pan); pan.connect(output); osc.connect(dep); dep.connect(pan.pan);
      nodes.push(mono, pan, dep);
      update = (amt, spd, immediate) => { setParam(ctx, dep.gain, .9 * clamp(amt, 0, 100) / 100, immediate); setParam(ctx, osc.frequency, modRate(type, spd), immediate, .05); };
    }
    update(amount, speed, true);
    return { entry: input, exit: output, nodes, kind: type, update };
  }

  // ---- Pan / width -----------------------------------------------------------------------------------
  // Pan: a constant-power balance (left × √2·cos θ, right × √2·sin θ, θ from 0 to π/2): the centre is
  // exactly as before, a mono sound keeps its loudness anywhere, a stereo sound keeps its width.
  function panGains(pan) { const th = (clamp(pan, -100, 100) / 100 + 1) * Math.PI / 4; return [Math.SQRT2 * Math.cos(th), Math.SQRT2 * Math.sin(th)]; }
  function panStage(ctx, pan) {
    const st = stereo(ctx), split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2), gl = gain(ctx), gr = gain(ctx);
    st.connect(split); split.connect(gl, 0); split.connect(gr, 1); gl.connect(merge, 0, 0); gr.connect(merge, 0, 1);
    const update = (v, immediate) => { const [l, r] = panGains(v); setParam(ctx, gl.gain, l, immediate); setParam(ctx, gr.gain, r, immediate); };
    update(pan, true);
    return { entry: st, exit: merge, nodes: [st, split, merge, gl, gr], update };
  }
  // Mid/side width: -100 = mono, 0 = as is, +100 = sides doubled.
  function widthStage(ctx, width) {
    const st = stereo(ctx), split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2), ll = gain(ctx), rl = gain(ctx), rr = gain(ctx), lr = gain(ctx);
    st.connect(split); split.connect(ll, 0); split.connect(lr, 0); split.connect(rr, 1); split.connect(rl, 1);
    ll.connect(merge, 0, 0); rl.connect(merge, 0, 0); rr.connect(merge, 0, 1); lr.connect(merge, 0, 1);
    const update = (v, immediate) => { const w = 1 + clamp(v, -100, 100) / 100; for (const g of [ll, rr]) setParam(ctx, g.gain, (1 + w) / 2, immediate); for (const g of [rl, lr]) setParam(ctx, g.gain, (1 - w) / 2, immediate); };
    update(width, true);
    return { entry: st, exit: merge, nodes: [st, split, merge, ll, rl, rr, lr], update };
  }

  // ---- Reverb room impulses --------------------------------------------------------------------------
  // Built once per context and room: pre-delay, early reflections, then a decaying tail whose highs die
  // away, with left and right different so the reverb is wide. Deterministic (seeded noise), so playback
  // and export sound the same. Normalised to the same energy.
  const impulses = new WeakMap();
  function roomImpulse(ctx, room) {
    let byCtx = impulses.get(ctx); if (!byCtx) impulses.set(ctx, byCtx = new Map());
    let buffer = byCtx.get(room); if (buffer) return buffer;
    const R = ROOMS[room] || ROOMS.hall, sr = ctx.sampleRate, length = Math.floor(sr * (R.pre + R.rt * 1.1));
    buffer = ctx.createBuffer(2, length, sr);
    let seed = 0x5eed1 + room.length * 104729; const noise = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2147483648 - 1; };
    const pre = Math.floor(R.pre * sr), decay = 6.91 / (R.rt * sr), T = length - pre, fade = Math.floor(length * .95);
    let energy = 0;
    for (let c = 0; c < 2; c++) {
      const d = buffer.getChannelData(c);
      for (let k = 0; k < R.er; k++) { const at = pre + Math.floor((.003 + R.erSpan * ((k + 1) / R.er) ** 1.3 + .006 * Math.abs(noise())) * sr); if (at < length) d[at] += (.5 - .04 * k) * (noise() < 0 ? -1 : 1); }
      // A plate builds up at once (no distinct reflections); rooms fade the tail in over 15 ms.
      const build = R.er ? .015 * sr : .002 * sr;
      let lp = 0;
      for (let i = 0; i < T; i++) {
        const t = i / T, fc = R.hiStart * Math.pow(R.hiEnd / R.hiStart, t), a = 1 - Math.exp(-2 * Math.PI * fc / sr);
        lp += a * (noise() - lp);
        d[pre + i] += lp * Math.exp(-decay * i) * Math.min(1, i / build);
      }
      for (let i = fade; i < length; i++) d[i] *= (length - i) / (length - fade);
      for (let i = 0; i < length; i++) energy += d[i] * d[i];
    }
    // Per channel energy REVERB_WET²: a full-level send gives a reverb ~8 dB below the dry sound.
    const k = REVERB_WET / Math.sqrt(energy / 2);
    for (let c = 0; c < 2; c++) { const d = buffer.getChannelData(c); for (let i = 0; i < length; i++) d[i] *= k; }
    byCtx.set(room, buffer); return buffer;
  }

  // ---- Pump ------------------------------------------------------------------------------------------
  // Envelope points [seconds after the kick, gain] for a preset at a tempo: down to the depth in
  // PUMP_ATTACK, then back to unity over the release (smoothstep in dB) in PUMP_STEPS linear pieces.
  function pumpPoints(preset, bpm) {
    const P = PUMP_PRESETS[preset]; if (!P) return null;
    const rel = P.release * 60 / clamp(num(bpm, 92), 40, 240), pts = [[PUMP_ATTACK, fromDb(P.depth)]];
    for (let i = 1; i <= PUMP_STEPS; i++) { const x = i / PUMP_STEPS, s = x * x * (3 - 2 * x); pts.push([PUMP_ATTACK + rel * x, fromDb(P.depth * (1 - s))]); }
    pts[pts.length - 1][1] = 1;
    return pts;
  }
  // The gain at time t of an envelope that started at kick time k0 from value v0.
  function envelopeAt(pts, k0, v0, t) {
    if (!pts || t <= k0) return v0;
    let pt = 0, pv = v0;
    for (const [dt, v] of pts) { if (t <= k0 + dt) return pv + (v - pv) * (t - k0 - pt) / Math.max(1e-9, dt - pt); pt = dt; pv = v; }
    return 1;
  }
  function createPump(ctx) {
    let preset = 'off', bpm = 92, pts = null;
    const gains = new Set(), kicks = []; // kicks: {t, v0, pts} in time order; old ones are dropped
    const valueAt = t => { for (let i = kicks.length - 1; i >= 0; i--) if (kicks[i].t <= t) return envelopeAt(kicks[i].pts, kicks[i].t, kicks[i].v0, t); return 1; };
    // Only the latest kick before a moment shapes the gain then (each envelope starts from the one before).
    const prune = () => { const now = ctx.currentTime; while (kicks.length > 1 && kicks[1].t < now) kicks.shift(); };
    function scheduleOn(param, k) {
      try {
        param.cancelScheduledValues(k.t);
        param.linearRampToValueAtTime(k.v0, k.t);
        for (const [dt, v] of k.pts) param.linearRampToValueAtTime(v, k.t + dt);
      } catch {}
    }
    // Brings `param` to unity from `from` on, continuing whatever envelope is sounding before that.
    function releaseFrom(param, from) {
      try {
        param.cancelScheduledValues(from);
        const k = [...kicks].reverse().find(x => x.t < from);
        if (!k) { param.linearRampToValueAtTime(1, from); return; }
        param.linearRampToValueAtTime(envelopeAt(k.pts, k.t, k.v0, from), from);
        for (const [dt, v] of k.pts) if (k.t + dt > from) param.linearRampToValueAtTime(v, k.t + dt);
      } catch {}
    }
    const pump = {
      get preset() { return preset; },
      get gains() { return gains; },
      set(next, nextBpm) {
        const p = pick(next, PUMP_PRESETS, 'off'), b = clamp(num(nextBpm, bpm), 40, 240);
        if (p === preset && b === bpm) return;
        preset = p; bpm = b; pts = pumpPoints(p, bpm);
        if (!pts) pump.cancelFrom(ctx.currentTime);
      },
      // A song kick sounds at time t (seconds on this context).
      kick(t) {
        if (!pts || !(t >= 0)) return;
        const last = kicks[kicks.length - 1];
        if (last && Math.abs(last.t - t) < .002) return; // two kick drums on one step: one duck
        if (last && t < last.t) return; // out of order (never in practice): ignore
        const k = { t, v0: valueAt(t), pts };
        kicks.push(k); prune();
        for (const g of gains) scheduleOn(g.gain, k);
      },
      // Kicks queued at or after `from` were cancelled (stop, pause, seek, preview): drop their ducks.
      cancelFrom(from) {
        const t = Math.max(0, num(from, ctx.currentTime));
        if (!kicks.some(k => k.t >= t - 1e-6)) return;
        for (const g of gains) releaseFrom(g.gain, t);
        for (let i = kicks.length - 1; i >= 0; i--) if (kicks[i].t >= t - 1e-6) kicks.splice(i, 1);
      },
      // Everything back to unity now (the transport stopped).
      reset() {
        kicks.length = 0;
        const now = ctx.currentTime;
        for (const g of gains) { try { g.gain.cancelScheduledValues(0); } catch {} g.gain.value = 1; try { g.gain.setValueAtTime(1, now); } catch {} }
      },
      attach(g) {
        if (gains.has(g)) return; gains.add(g);
        const now = ctx.currentTime, active = kicks.filter(k => k.t + k.pts[k.pts.length - 1][0] > now);
        if (!active.length) return;
        try { g.gain.cancelScheduledValues(0); g.gain.setValueAtTime(valueAt(now), now); } catch {}
        for (const k of active) if (k.t > now) scheduleOn(g.gain, k); else for (const [dt, v] of k.pts) if (k.t + dt > now) try { g.gain.linearRampToValueAtTime(v, k.t + dt); } catch {}
      },
      detach(g) {
        if (!gains.delete(g)) return;
        const now = ctx.currentTime;
        try { g.gain.cancelScheduledValues(now); g.gain.setValueAtTime(valueAt(now), now); g.gain.linearRampToValueAtTime(1, now + .02); } catch { g.gain.value = 1; }
      },
      valueAt,
    };
    return pump;
  }

  // ---- Song FX ---------------------------------------------------------------------------------------
  // createSongFx(ctx, destination, {level}) → {input, reverbSend, delaySend, pump, set, dispose}
  // `level` is the mix's nominal loudness at the input (for the glue). The shared reverb and delay are only
  // built while some track sends to them.
  function createSongFx(ctx, destination, { level = LEVELS.song } = {}) {
    const input = stereo(ctx), p1 = gain(ctx), p2 = gain(ctx), out = gain(ctx);
    out.connect(destination);
    const eq = makeSlot(ctx, input, p1), glue = makeSlot(ctx, p1, p2), width = makeSlot(ctx, p2, out);
    const reverbSend = gain(ctx), delaySend = gain(ctx), pump = createPump(ctx);
    let settings = normalizeSongFx(null), bpm = 92, rev = null, dly = null;
    const users = { reverb: new Set(), delay: new Set() }, teardown = { reverb: 0, delay: 0 };
    function buildReverb(level = settings.reverb / 100) {
      const hp = biquad(ctx, 'highpass', 150, .7), lp = biquad(ctx, 'lowpass', 9000, .7), conv = ctx.createConvolver(), ret = gain(ctx, level);
      conv.normalize = false; conv.buffer = roomImpulse(ctx, settings.room);
      reverbSend.connect(hp); hp.connect(lp); lp.connect(conv); conv.connect(ret); ret.connect(input);
      return { hp, lp, conv, ret, room: settings.room };
    }
    // A delay inside a feedback loop repeats one render quantum (128 frames) late in Chrome and Safari,
    // so the loop's delay is a quantum short and a fixed quantum of pre-delay puts the first echo back:
    // echoes land exactly on the note value.
    const quantum = 128 / ctx.sampleRate, loopDelay = t => Math.max(quantum, t - quantum);
    function buildDelay() {
      const pre = ctx.createDelay(.05), d = ctx.createDelay(DELAY_MAX_SEC + .1), fb = gain(ctx, Math.min(FEEDBACK_MAX, settings.feedback / 100 * FEEDBACK_MAX)), fbHp = biquad(ctx, 'highpass', 220, .7), fbLp = biquad(ctx, 'lowpass', 4800, .7), ret = gain(ctx, DELAY_RETURN);
      pre.delayTime.value = quantum; d.delayTime.value = loopDelay(delaySeconds(settings.delay, bpm));
      delaySend.connect(pre); pre.connect(d); d.connect(ret); ret.connect(input); d.connect(fbHp); fbHp.connect(fbLp); fbLp.connect(fb); fb.connect(d);
      return { pre, d, fb, fbHp, fbLp, ret };
    }
    function drop(kind) {
      if (kind === 'reverb' && rev) { try { reverbSend.disconnect(rev.hp); } catch {} disconnectAll([rev.hp, rev.lp, rev.conv, rev.ret]); rev = null; }
      if (kind === 'delay' && dly) { try { delaySend.disconnect(dly.pre); } catch {} disconnectAll([dly.pre, dly.d, dly.fb, dly.fbHp, dly.fbLp, dly.ret]); dly = null; }
    }
    function refreshSends() {
      for (const kind of ['reverb', 'delay']) {
        const want = users[kind].size > 0;
        if (want) { clearTimeout(teardown[kind]); teardown[kind] = 0; if (kind === 'reverb' && !rev) rev = buildReverb(); if (kind === 'delay' && !dly) dly = buildDelay(); }
        else if ((kind === 'reverb' ? rev : dly) && !teardown[kind]) {
          // Let the tail ring out, then take the convolver / delay out of the graph.
          const ms = kind === 'reverb' ? (ROOMS[rev.room]?.rt || 2) * 1200 + 200 : 4000;
          teardown[kind] = setTimeout(() => { teardown[kind] = 0; if (!users[kind].size) drop(kind); }, ms);
        }
      }
    }
    const fx = {
      input, reverbSend, delaySend, pump, output: out,
      get settings() { return { ...settings }; },
      get active() { return { reverb: !!rev, delay: !!dly }; },
      // A track starts or stops sending to the shared reverb/delay (kind 'reverb' | 'delay').
      use(kind, user, on) { if (!users[kind]) return; if (on) users[kind].add(user); else users[kind].delete(user); refreshSends(); },
      // Drop a send's reverb/delay at once when nobody uses it (transport stopped: everything is silent).
      flush() { for (const kind of ['reverb', 'delay']) if (!users[kind].size) { clearTimeout(teardown[kind]); teardown[kind] = 0; drop(kind); } },
      set(next, { bpm: nextBpm, immediate = false } = {}) {
        const s = normalizeSongFx(next), prev = settings;
        if (Number.isFinite(Number(nextBpm))) bpm = clamp(Number(nextBpm), 40, 240);
        settings = s;
        if (s.eq !== prev.eq || !eq.stage !== (s.eq === 'off')) eq.replace(s.eq === 'off' ? null : eqStage(ctx, s.eq, s.eqAmount), immediate);
        else eq.stage?.update(s.eqAmount, immediate);
        if (s.glue !== prev.glue || !glue.stage !== (s.glue === 'off')) glue.replace(s.glue === 'off' ? null : compStage(ctx, GLUE_PRESETS[s.glue], level), immediate);
        if ((s.width === 0) !== !width.stage) width.replace(s.width === 0 ? null : widthStage(ctx, s.width), immediate);
        else width.stage?.update(s.width, immediate);
        if (rev) {
          if (rev.room !== s.room) {
            // Another room: the new one takes over the send while the old tail rings out.
            const old = rev; rev = buildReverb(immediate ? s.reverb / 100 : 0);
            if (!immediate) { rev.ret.gain.setValueAtTime(0, ctx.currentTime); rev.ret.gain.linearRampToValueAtTime(s.reverb / 100, ctx.currentTime + XFADE); }
            try { reverbSend.disconnect(old.hp); } catch {}
            setTimeout(() => disconnectAll([old.hp, old.lp, old.conv, old.ret]), (ROOMS[old.room]?.rt || 2) * 1200);
          } else setParam(ctx, rev.ret.gain, s.reverb / 100, immediate, .03);
        }
        if (dly) { setParam(ctx, dly.d.delayTime, loopDelay(delaySeconds(s.delay, bpm)), immediate, .05); setParam(ctx, dly.fb.gain, Math.min(FEEDBACK_MAX, s.feedback / 100 * FEEDBACK_MAX), immediate, .03); }
        pump.set(s.pump, bpm);
        return fx;
      },
      dispose() {
        pump.reset(); clearTimeout(teardown.reverb); clearTimeout(teardown.delay); drop('reverb'); drop('delay');
        eq.dispose(); glue.dispose(); width.dispose(); disconnectAll([input, p1, p2, out, reverbSend, delaySend]);
      },
    };
    fx.set(settings, { immediate: true });
    return fx;
  }

  // ---- Track / clip FX -------------------------------------------------------------------------------
  // createTrackFx(ctx, destination, songFx, {level, trim}) → {input, duck, set, dispose}
  // `level` is the nominal loudness of the material at the input (for drive/compression); `trim` is a fixed
  // output gain (Baby DAW's mix headroom for instrument parts). The duck gain (pump) is after the
  // effects and before the sends; songFx may be null (no sends, no pump).
  function createTrackFx(ctx, destination, songFx = null, { level = LEVELS.chord, trim = 1 } = {}) {
    const input = gain(ctx), p = [gain(ctx), gain(ctx), gain(ctx), gain(ctx)], duck = gain(ctx), out = gain(ctx, trim), sends = { reverb: gain(ctx, 0), delay: gain(ctx, 0) };
    const eq = makeSlot(ctx, input, p[0]), drive = makeSlot(ctx, p[0], p[1]), comp = makeSlot(ctx, p[1], p[2]), mod = makeSlot(ctx, p[2], p[3]), pan = makeSlot(ctx, p[3], duck);
    duck.connect(out); out.connect(destination);
    out.connect(sends.reverb); out.connect(sends.delay);
    const linked = { reverb: false, delay: false };
    let settings = null, ducking = false, disposed = false;
    const fx = {
      input, duck, output: out,
      get settings() { return settings ? { ...settings } : null; },
      set(next, { immediate = false } = {}) {
        if (disposed) return fx;
        const f = effectiveTrackFx(next), prev = settings || { ...TRACK_DEFAULT, duck: false };
        settings = f;
        if (f.eq !== prev.eq || !eq.stage !== (f.eq === 'off')) eq.replace(f.eq === 'off' ? null : eqStage(ctx, f.eq, f.eqAmount), immediate);
        else eq.stage?.update(f.eqAmount, immediate);
        if (f.drive !== prev.drive || !drive.stage !== (f.drive === 'off')) drive.replace(f.drive === 'off' ? null : driveStage(ctx, f.drive, f.driveAmount, level), immediate);
        else drive.stage?.update(f.driveAmount, immediate);
        if (f.comp !== prev.comp || !comp.stage !== (f.comp === 'off')) comp.replace(f.comp === 'off' ? null : compStage(ctx, COMP_PRESETS[f.comp], level), immediate);
        if (f.mod !== prev.mod || !mod.stage !== (f.mod === 'off')) mod.replace(f.mod === 'off' ? null : modStage(ctx, f.mod, f.modAmount, f.modSpeed), immediate);
        else mod.stage?.update(f.modAmount, f.modSpeed, immediate);
        if ((f.pan === 0) !== !pan.stage) pan.replace(f.pan === 0 ? null : panStage(ctx, f.pan), immediate);
        else pan.stage?.update(f.pan, immediate);
        for (const kind of ['reverb', 'delay']) {
          const v = songFx ? f[kind] / 100 : 0, on = v > 0, target = kind === 'reverb' ? songFx?.reverbSend : songFx?.delaySend;
          if (on && !linked[kind] && target) { songFx.use(kind, fx, true); sends[kind].connect(target); linked[kind] = true; sends[kind].gain.value = 0; }
          setParam(ctx, sends[kind].gain, v, immediate || (!on && !linked[kind]), .02);
          if (!on && linked[kind]) {
            // Unhook once the send has faded, so an unused send costs nothing.
            linked[kind] = false;
            const node = sends[kind], target0 = target;
            setTimeout(() => { if (!linked[kind]) { try { node.disconnect(target0); } catch {} songFx?.use(kind, fx, false); } }, immediate ? 0 : 120);
          }
        }
        const wantDuck = !!(songFx && f.duck);
        if (wantDuck !== ducking) { ducking = wantDuck; if (wantDuck) songFx.pump.attach(duck); else songFx.pump.detach(duck); }
        return fx;
      },
      dispose() {
        if (disposed) return; disposed = true;
        if (ducking) songFx?.pump.gains.delete(duck);
        for (const kind of ['reverb', 'delay']) songFx?.use(kind, fx, false);
        eq.dispose(); drive.dispose(); comp.dispose(); mod.dispose(); pan.dispose();
        disconnectAll([input, ...p, duck, out, sends.reverb, sends.delay]);
      },
    };
    return fx;
  }

  // ---- Live routing hooks ----------------------------------------------------------------------------
  // Beat Maker (beat-maker.js) asks where a song drum hit goes and reports each song kick; Baby DAW
  // (parts.js) answers through the router it registers. Without a router the drums play as before.
  let router = null;
  const api = {
    EQ_PRESETS, EQ_LABELS, COMP_PRESETS, COMP_LABELS, GLUE_PRESETS, GLUE_LABELS, DRIVE_PRESETS, DRIVE_LABELS,
    MOD_RATES, MOD_LABELS, ROOMS, ROOM_LABELS, DELAY_TIMES, DELAY_LABELS, PUMP_PRESETS, PUMP_LABELS,
    TRACK_DEFAULT, SONG_DEFAULT, PUMP_ATTACK, REVERB_WET, DELAY_RETURN, FEEDBACK_MAX, REF_RMS, CREST, LEVELS,
    normalizeTrackFx, normalizeSongFx, isDefault, effectiveTrackFx, modRate, delaySeconds, driveGain, pumpPoints, envelopeAt, db, fromDb,
    createSongFx, createTrackFx, createPump, roomImpulse,
    setLiveRouter(r) { router = r || null; },
    drumDestination(ctx, regionId) { try { return router?.drumDestination?.(ctx, regionId) || null; } catch (e) { console.warn('Drum FX routing failed', e); return null; } },
    onKick(ctx, time, regionId) { try { router?.onKick?.(ctx, time, regionId); } catch (e) { console.warn('Pump kick failed', e); } },
    onKickCancel(ctx, from) { try { router?.onKickCancel?.(ctx, from); } catch (e) { console.warn('Pump cancel failed', e); } },
  };
  window.CRPMusicFx = api;
})();
