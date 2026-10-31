/**
 * Deterministic 32-bit PRNG (Mulberry32).
 * Given the same seed, produces an identical [0, 1) float sequence across all platforms.
 */
export class DeterministicRng {
  private state: number;

  constructor(seed: number = 20261030) {
    this.state = seed >>> 0;
  }

  /** Returns a float in [0, 1). */
  nextFloat(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Returns true with probability p (clamped to [0, 1]). */
  prob(p: number): boolean {
    if (p <= 0) return false;
    if (p >= 1) return true;
    return this.nextFloat() < p;
  }

  /** Clone current RNG state for branching. */
  clone(): DeterministicRng {
    const copy = new DeterministicRng(0);
    copy.state = this.state;
    return copy;
  }
}
