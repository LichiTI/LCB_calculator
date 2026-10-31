/**
 * Teammate support model: per-turn resources / buffs supplied by an ally whose own actions
 * are not simulated in full (only the parts that feed the main identity).
 *
 * Currently implemented: "leNoirManager" = 高级定制::黑派 品牌经理 堂吉诃德 (#10315), as seen
 * from a Le Noir ally (e.g. #10617). Burst damage itself is intentionally NOT modelled.
 *
 * Data sources (unpacked):
 *   - Passive 1031502: on first entry, other Le Noir allies gain 2 [Charge] Count.
 *   - Skill 1031501 (S1) [WhenUse]: self + the Le Noir ally with the least Charge gain 4 Charge (once per turn).
 *   - Passive 1031504: when a target with [NoirNailDonQuixote] is Tremor-Burst, self + the ally with the least
 *     Charge gain 2 Charge (max 2 times per turn). Don's own bursts: S2 coin 2 (1), S3 coin 3 (+1 at 3+ nails).
 *     The nail is assumed present from T1 (Don's 1031505 auto-attack before every Le Noir ally attack).
 *   - Skill 1031503 (S3) [StartBattle]: the fastest other Le Noir ally gains 2 [AttackUp] (Offense Level +2 this turn).
 * Don is assumed to act before the ally each turn (higher speed + Agility from Sanctum).
 */

export type DonAction = "s1" | "s2" | "s3";

export interface TeammateSupport {
  kind: "leNoirManager";
  enabled: boolean;
  /** Don's action per turn, cycled when shorter than the simulation. */
  schedule: DonAction[];
  entryCharge: number;
  s1Charge: number;
  burstCharge: number;
  burstCapPerTurn: number;
  s3AttackUp: number;
  donBursts: Record<DonAction, number>;
}

export const DEFAULT_DON_SCHEDULE: DonAction[] = ["s1", "s2", "s1", "s3", "s1", "s2"];

export function defaultLeNoirManagerSupport(enabled = true): TeammateSupport {
  return {
    kind: "leNoirManager",
    enabled,
    schedule: [...DEFAULT_DON_SCHEDULE],
    entryCharge: 2,
    s1Charge: 4,
    burstCharge: 2,
    burstCapPerTurn: 2,
    s3AttackUp: 2,
    donBursts: { s1: 0, s2: 1, s3: 2 },
  };
}

export function readTeammateSupport(raw: unknown): TeammateSupport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<TeammateSupport>;
  if (r.kind !== "leNoirManager") return null;
  const d = defaultLeNoirManagerSupport(r.enabled !== false);
  const schedule = Array.isArray(r.schedule) ? r.schedule.filter((x): x is DonAction => x === "s1" || x === "s2" || x === "s3") : d.schedule;
  return {
    ...d,
    ...r,
    kind: "leNoirManager",
    enabled: r.enabled !== false,
    schedule: schedule.length ? schedule : d.schedule,
    donBursts: { ...d.donBursts, ...(r.donBursts ?? {}) },
  };
}

export function donActionAt(sup: TeammateSupport, turn: number): DonAction {
  return sup.schedule[(turn - 1) % sup.schedule.length] ?? "s1";
}

/** All valid orders of one Don deck (S1×3, S2×2, S3×1) = 60. */
export function allDonDeckOrders(): DonAction[][] {
  const out: DonAction[][] = [];
  const counts: Record<DonAction, number> = { s1: 3, s2: 2, s3: 1 };
  const cur: DonAction[] = [];
  const rec = () => {
    if (cur.length === 6) {
      out.push([...cur]);
      return;
    }
    for (const k of ["s1", "s2", "s3"] as DonAction[]) {
      if (!counts[k]) continue;
      counts[k]--;
      cur.push(k);
      rec();
      cur.pop();
      counts[k]++;
    }
  };
  rec();
  return out;
}
