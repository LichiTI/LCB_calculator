/** DOT configuration value objects; no game trigger or damage rules live here. */
export interface StatusAmountData {
  potency: number;
  count: number;
}

export class StatusAmount implements StatusAmountData {
  readonly potency: number;
  readonly count: number;

  constructor(potency = 0, count = 0) {
    if (!Number.isSafeInteger(potency) || potency < 0) {
      throw new RangeError("potency must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError("count must be a non-negative safe integer");
    }
    this.potency = potency;
    this.count = count;
  }

  static fromJSON(value: unknown): StatusAmount {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("Expected { potency, count }");
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.potency !== "number" ||
      typeof record.count !== "number"
    ) {
      throw new TypeError("potency and count must both be numbers");
    }
    return new StatusAmount(record.potency, record.count);
  }

  toJSON(): StatusAmountData {
    return { potency: this.potency, count: this.count };
  }
}

/** Keys are stable game status IDs, not translated display names. */
export type DotMap<K extends string = string> = Partial<
  Record<K, StatusAmountData>
>;

/** Index i describes manual extra applications by logical coin i. */
export type CoinDots<K extends string = string> = DotMap<K>[];

// Generic usage example, not an actual identity's skill data:
// const coinDots: CoinDots<"Combustion" | "Laceration"> = [
//   { Combustion: new StatusAmount(3, 1) },
//   { Laceration: new StatusAmount(2, 0) },
//   {},
// ];
// JSON.stringify(coinDots) produces ordinary JSON objects.
// JSON.parse returns plain data; use StatusAmount.fromJSON for class instances.
