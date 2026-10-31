/** Persisted global defaults (localStorage). UI-only; never changes stored preset content. */
import type { BonusTier } from "../engine/bonus-tier";
import type { CoinMode } from "../engine/simulator";

export type UiMode = "simple" | "advanced";

export interface AppSettings {
  uiMode: UiMode;
  defaultLevel: number;
  /** null = same as identity level */
  defaultTargetDefense: number | null;
  defaultSp: number;
  defaultCoinMode: CoinMode;
  defaultSimMode: "staticCycle" | "orderedCycle" | "multiTurn";
  /** Bonus tier used in simple mode and for new presets. */
  defaultBonusTier: BonusTier;
  defaultSlots: 1 | 2;
  defaultBattlePassives: "automatic" | "none";
}

export const DEFAULT_SETTINGS: AppSettings = {
  uiMode: "simple",
  defaultLevel: 65,
  defaultTargetDefense: null,
  defaultSp: 45,
  defaultCoinMode: "allHeads",
  defaultSimMode: "orderedCycle",
  defaultBonusTier: "full",
  defaultSlots: 1,
  defaultBattlePassives: "automatic",
};

const KEY = "lcalc.settings.v1";

export function loadSettings(storage: Storage = localStorage): AppSettings {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: AppSettings, storage: Storage = localStorage) {
  storage.setItem(KEY, JSON.stringify(s));
}
