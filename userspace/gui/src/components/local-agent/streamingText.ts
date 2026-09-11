const REVEAL_WINDOW_MS = 120;

/** Reveal only received text. Each active window catches up within 120 ms,
 * regardless of chunk size; new arrivals cannot extend an existing deadline. */
export class StreamingTextBuffer {
  private source: string;
  private length: number;
  private deadline = 0;
  private lastFrame = 0;

  constructor(text = '') {
    this.source = text;
    this.length = text.length;
  }

  get text(): string { return this.source.slice(0, this.length); }
  get complete(): boolean { return this.length === this.source.length; }

  update(text: string, now: number): void {
    if (text === this.source) return;
    if (!text.startsWith(this.source)) {
      // A replacement is authoritative, never interpolate through the old text.
      this.source = text;
      this.length = text.length;
      return;
    }
    if (this.complete) {
      this.deadline = now + REVEAL_WINDOW_MS;
      this.lastFrame = now;
    }
    this.source = text;
  }

  advance(now: number): string {
    if (this.complete || now <= this.lastFrame) return this.text;
    const fraction = now >= this.deadline ? 1 : (now - this.lastFrame) / (this.deadline - this.lastFrame);
    this.length += Math.ceil((this.source.length - this.length) * fraction);
    // Keep UTF-16 surrogate pairs intact while revealing Unicode text.
    const previous = this.source.charCodeAt(this.length - 1);
    const next = this.source.charCodeAt(this.length);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) this.length += 1;
    this.lastFrame = now;
    return this.text;
  }
}
