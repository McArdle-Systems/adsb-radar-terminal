// audio.js — the radar "ping" on a fresh contact. Pure WebAudio, no assets.
// Browsers block audio until a user gesture; call unlock() from a click.

export class PingAudio {
  constructor(opts = {}) {
    this.enabled = opts.enabled !== false;
    this.volume = opts.volume ?? 0.25;
    this.ctx = null;
    this.unlocked = false;
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    this.unlocked = true;
  }

  setEnabled(on) { this.enabled = on; }

  /**
   * A short two-tone sonar-ish blip. `warn` raises the pitch for emergencies.
   */
  ping({ warn = false } = {}) {
    if (!this.enabled || !this.ctx || !this.unlocked) return;
    const t0 = this.ctx.currentTime;
    const base = warn ? 1320 : 880;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(base, t0);
    osc.frequency.exponentialRampToValueAtTime(base * 0.62, t0 + 0.18);

    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(this.volume, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.42);

    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.45);
  }
}
