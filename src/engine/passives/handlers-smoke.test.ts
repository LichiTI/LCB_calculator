/**
 * Smoke test for all translated passive / script / status-ability handlers.
 * For every identity: default 6T rotation (allHeads + allTails), plus one rotation per E.G.O skill of the same sinner
 * (E.G.O used on turn 6). Asserts no exception, finite non-negative damage, no NaN in status stacks.
 * Records which handlers were invoked and writes data/reports/handler-coverage.json.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CoreData } from "../../data/game-data";
import { baseEntryFor, createPresetForIdentity } from "../../config/preset-factory";
import { simulateScenario, type SimulationResult } from "../simulator";
import { ABILITIES, ABILITY_PATTERNS, PASSIVES, SCRIPTS, SCRIPT_PATTERNS, abilityHandler, scriptHandler } from "./index";

const corePath = new URL("../../../public/data/core.json", import.meta.url);
const outPath = new URL("../../../data/reports/handler-coverage.json", import.meta.url);

const SCRIPT_HOOKS = ["skillMods", "beforeCoin", "beforeUse", "coinMods", "rerolls", "onCoinHit", "onSkillEnd"] as const;
const ABILITY_HOOKS = ["coinMods", "onCoinHit", "onRoundEnd", "onRoundStart", "onBattleStart", "onSkillStart", "onVibrationExplosion"] as const;
const PASSIVE_HOOKS = ["onBattleStart", "onTurnStart", "skillMods", "coinMods", "onCoinHit", "onSkillEnd", "onRoundEnd", "onVibrationExplosion"] as const;

const keyOf = (n: string | RegExp) => (typeof n === "string" ? n : `/${n.source}/`);

interface HandlerInfo {
  key: string;
  kind: "script" | "ability" | "passive";
  hooks: number;
}

const invoked = new Set<string>();
const handlers = new Map<string, HandlerInfo>();
let lastThrower: string | null = null;

function wrap(obj: Record<string, unknown>, hooks: readonly string[], key: string, kind: HandlerInfo["kind"]): void {
  let n = 0;
  for (const h of hooks) {
    const fn = obj[h];
    if (typeof fn !== "function") continue;
    n++;
    obj[h] = function (this: unknown, ...args: unknown[]) {
      invoked.add(key);
      try {
        return (fn as (...a: unknown[]) => unknown).apply(this, args);
      } catch (e) {
        lastThrower ??= `${key}.${h}`;
        throw e;
      }
    };
  }
  handlers.set(key, { key, kind, hooks: n });
}

let wrapped = false;
function instrument(): void {
  if (wrapped) return;
  wrapped = true;
  const seen = new Set<object>();
  for (const h of [...SCRIPTS.values(), ...SCRIPT_PATTERNS]) {
    if (seen.has(h)) continue;
    seen.add(h);
    wrap(h as unknown as Record<string, unknown>, SCRIPT_HOOKS, `script:${keyOf(h.name)}`, "script");
  }
  for (const h of [...ABILITIES.values(), ...ABILITY_PATTERNS]) {
    if (seen.has(h)) continue;
    seen.add(h);
    wrap(h as unknown as Record<string, unknown>, ABILITY_HOOKS, `ability:${keyOf(h.name)}`, "ability");
  }
  for (const h of PASSIVES.values()) {
    if (seen.has(h)) continue;
    seen.add(h);
    wrap(h as unknown as Record<string, unknown>, PASSIVE_HOOKS, `passive:${h.id}`, "passive");
  }
}

/** Returns problems found in a result (non-finite / negative damage, NaN stacks). */
function checkResult(res: SimulationResult): string[] {
  const bad: string[] = [];
  const num = (v: unknown, where: string, nonNeg: boolean) => {
    if (v === undefined || v === null) return;
    if (typeof v !== "number" || !Number.isFinite(v)) bad.push(`${where}=${String(v)}`);
    else if (nonNeg && v < 0) bad.push(`${where}=${v}<0`);
  };
  for (const [k, v] of Object.entries(res.totals)) num(v, `totals.${k}`, true);
  for (const e of res.perEntry) for (const k of ["direct", "extra", "dotHp", "total"] as const) num(e[k], `perEntry[${e.entryId}].${k}`, true);
  for (const ev of res.events) {
    num(ev.damage, `event T${ev.turn} ${ev.kind}.damage`, true);
    num(ev.floatDamage, `event T${ev.turn} ${ev.kind}.floatDamage`, true);
    num(ev.power, `event T${ev.turn} ${ev.kind}.power`, false);
    if (ev.dot) num(ev.dot.hpDamage, `event T${ev.turn} dot ${ev.dot.statusId}.hpDamage`, true);
  }
  for (const r of res.dotBreakdown) num(r.hpDamage, `dot ${r.statusId}.hpDamage`, true);
  for (const s of res.statusApplications) {
    num(s.before.potency, `status ${s.statusId}.before.potency`, false);
    num(s.before.count, `status ${s.statusId}.before.count`, false);
    num(s.after.potency, `status ${s.statusId}.after.potency`, false);
    num(s.after.count, `status ${s.statusId}.after.count`, false);
  }
  for (const s of res.remainingStatuses) {
    num(s.potency, `remaining ${s.side}:${s.id}.potency`, false);
    num(s.count, `remaining ${s.side}:${s.id}.count`, false);
  }
  return bad.slice(0, 5);
}

interface Failure {
  identityId: number;
  run: string;
  handler: string | null;
  error: string;
  stack: string[];
}

describe.skipIf(!existsSync(corePath))("handler smoke test (all identities)", () => {
  it("runs every identity / E.G.O rotation without errors", () => {
    instrument();
    const core = JSON.parse(readFileSync(corePath, "utf8")) as CoreData;
    const simData = { identities: core.identities, skills: core.skills, buffs: core.buffs };
    const egoSkillsByChar = new Map<number, number[]>();
    for (const ego of (core as unknown as { egos?: { characterId: number; awakeningSkillId?: number | null; corrosionSkillId?: number | null }[] }).egos ?? []) {
      const list = egoSkillsByChar.get(ego.characterId) ?? [];
      for (const s of [ego.awakeningSkillId, ego.corrosionSkillId]) if (s && core.skills[String(s)]) list.push(s);
      egoSkillsByChar.set(ego.characterId, list);
    }

    const failures: Failure[] = [];
    let runs = 0;
    let passed = 0;
    const t0 = Date.now();
    for (const idt of core.identities) {
      const variants: { label: string; build: () => ReturnType<typeof createPresetForIdentity>; mode: "allHeads" | "allTails" }[] = [
        { label: "default/allHeads", build: () => createPresetForIdentity(idt, core.skills, core.manifest.dataVersion, "smoke"), mode: "allHeads" },
        { label: "default/allTails", build: () => createPresetForIdentity(idt, core.skills, core.manifest.dataVersion, "smoke"), mode: "allTails" },
        {
          // S3 early so statuses applied by S3 (often activeRound 1) are active in later turns.
          label: "s3-first/allHeads",
          mode: "allHeads",
          build: () => {
            const p = createPresetForIdentity(idt, core.skills, core.manifest.dataVersion, "smoke");
            const ids = new Map(p.skillGroups.base.map((e) => [e.slot, e.entryId]));
            const order = ["S3", "S1", "S2", "S3", "S1", "S2"];
            (p.simulation.actionSchedule ?? []).forEach((a, i) => {
              a.entryId = ids.get(order[i]!) ?? a.entryId;
            });
            return p;
          },
        },
      ];
      for (const egoId of egoSkillsByChar.get((idt as unknown as { characterId: number }).characterId) ?? []) {
        variants.push({
          label: `ego ${egoId}`,
          mode: "allHeads",
          build: () => {
            const p = createPresetForIdentity(idt, core.skills, core.manifest.dataVersion, "smoke");
            p.skillGroups.base.push(baseEntryFor(core.skills[String(egoId)]!, "ego", 1));
            const sched = p.simulation.actionSchedule ?? [];
            const last = sched[sched.length - 1];
            if (last) last.entryId = "ego";
            return p;
          },
        });
      }
      for (const v of variants) {
        runs++;
        lastThrower = null;
        try {
          const res = simulateScenario(simData, v.build(), { coinMode: v.mode });
          const bad = checkResult(res);
          if (bad.length) failures.push({ identityId: idt.id, run: v.label, handler: null, error: `invalid numbers: ${bad.join("; ")}`, stack: [] });
          else passed++;
        } catch (e) {
          const err = e as Error;
          failures.push({
            identityId: idt.id,
            run: v.label,
            handler: lastThrower,
            error: String(err?.message ?? err),
            stack: String(err?.stack ?? "").split("\n").slice(1, 5).map((l) => l.trim()),
          });
        }
      }
    }
    const elapsedMs = Date.now() - t0;

    // Static matching: which data script / ability names resolve to a registered handler.
    const matched = new Set<string>();
    const scriptNames = new Set<string>();
    for (const s of Object.values(core.skills) as unknown as { abilityScripts?: { scriptName?: string }[]; coins?: { abilityScriptList?: { scriptName?: string }[] }[] }[]) {
      for (const a of s.abilityScripts ?? []) if (a.scriptName) scriptNames.add(a.scriptName);
      for (const c of s.coins ?? []) for (const a of c.abilityScriptList ?? []) if (a.scriptName) scriptNames.add(a.scriptName);
    }
    for (const n of scriptNames) {
      const h = scriptHandler(n);
      if (h) matched.add(`script:${keyOf(h.name)}`);
    }
    for (const b of Object.values(core.buffs) as unknown as { list?: { ability?: string }[] }[]) {
      for (const it of b.list ?? []) {
        const h = it.ability ? abilityHandler(it.ability) : undefined;
        if (h) matched.add(`ability:${keyOf(h.name)}`);
      }
    }

    const all = [...handlers.values()];
    const withHooks = all.filter((h) => h.hooks > 0);
    const neverInvoked = withHooks.filter((h) => !invoked.has(h.key)).map((h) => h.key).sort();
    const unmatched = all.filter((h) => h.kind !== "passive" && !matched.has(h.key)).map((h) => h.key).sort();
    const summary = {
      runs,
      passed,
      failed: failures.length,
      elapsedMs,
      handlers: all.length,
      handlersWithHooks: withHooks.length,
      hooklessHandlers: all.length - withHooks.length,
      invoked: withHooks.length - neverInvoked.length,
      neverInvokedCount: neverInvoked.length,
      unmatchedByDataCount: unmatched.length,
      failures,
      neverInvoked,
      unmatchedByData: unmatched,
    };
    writeFileSync(outPath, JSON.stringify(summary, null, 1));
    console.log(
      `[handler-smoke] runs=${runs} passed=${passed} failed=${failures.length} ${elapsedMs}ms; ` +
        `handlers=${all.length} (hooks ${withHooks.length}), neverInvoked=${neverInvoked.length}, unmatchedByData=${unmatched.length}`,
    );
    for (const f of failures.slice(0, 30)) console.log(`  FAIL ${f.identityId} [${f.run}] ${f.handler ?? "-"}: ${f.error}\n    ${f.stack.join("\n    ")}`);
    expect(failures).toEqual([]);
  }, 120000);
});
