/**
 * Generates raw data for data/reports/best-output-10617-10315.md (optimizer runs for Hong Lu 10617 / Don Quixote 10315).
 * Opt-in: set BEST_OUTPUT_REPORT=1. Writes data/reports/best-output-10617-10315.raw.json.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import type { CoreData } from "../data/game-data";
import { createPresetForIdentity } from "../config/preset-factory";
import { optimizeSchedule } from "./optimizer";
import { PASSIVES, abilityHandler, scriptHandler } from "./passives";

const corePath = new URL("../../public/data/core.json", import.meta.url);
const outPath = new URL("../../data/reports/best-output-10617-10315.raw.json", import.meta.url);
const enabled = existsSync(corePath) && !!process.env.BEST_OUTPUT_REPORT;

describe.skipIf(!enabled)("best output report 10617 / 10315", () => {
  it("runs optimizer modes", () => {
    const core = JSON.parse(readFileSync(corePath, "utf8")) as CoreData;
    const data = { identities: core.identities, skills: core.skills, buffs: core.buffs };
    const out: Record<string, unknown> = {};
    for (const id of [10617, 10315]) {
      const idt = core.identities.find((i) => i.id === id)!;
      const per: Record<string, unknown> = {};
      for (const tier of ["none", "full"] as const) {
        const preset = createPresetForIdentity(idt, core.skills, core.manifest.dataVersion, "report", {
          level: 65, targetDefense: 65, sp: 45, bonusTier: tier,
        });
        const entries = preset.skillGroups.base.map((e) => ({ entryId: e.entryId, skillId: e.skillId, uses: e.usesPerCycle }));
        const modes: Record<string, unknown> = {};
        for (const m of [
          { key: "6T-single", slots: 1 as const, turns: 6 },
          { key: "12T-single", slots: 1 as const, turns: 12 },
          { key: "6T-double", slots: 2 as const, turns: 6 },
        ]) {
          const t0 = Date.now();
          const r = optimizeSchedule(data, preset, { slots: m.slots, turns: m.turns, coinMode: "allHeads", topN: 4, maxCandidates: 20000 });
          const br = r.bestResult!;
          const dotByStatus: Record<string, number> = {};
          for (const d of br.dotBreakdown) dotByStatus[d.statusId] = (dotByStatus[d.statusId] ?? 0) + d.hpDamage;
          const coins = br.events
            .filter((e) => e.kind === "coin" && e.breakdown)
            .slice(0, 40)
            .map((e) => ({ turn: e.turn, skillId: e.skillId, coinIndex: e.coinIndex, rerolled: e.isRerolled, power: e.power, coinScale: e.coinScale,
              off: e.offenseLevel, def: e.defenseLevel, damage: e.damage, b: e.breakdown }));
          const uses = br.events.filter((e) => e.kind === "useSkill").map((e) => ({ turn: e.turn, skillId: e.skillId, entryId: e.entryId, msg: e.message }));
          const notes = br.events.filter((e) => e.kind === "note").map((e) => `T${e.turn} ${e.message}`);
          const extras = br.events.filter((e) => e.kind === "extraDamage").map((e) => `T${e.turn} ${e.damage} ${e.message}`);
          modes[m.key] = {
            evaluated: r.evaluated, truncated: r.truncated, ms: Date.now() - t0,
            best: r.best, worst: r.worst?.total, top: r.top,
            totals: br.totals, perEntry: br.perEntry, dotByStatus, quality: br.quality,
            gaps: br.gaps, assumptions: br.assumptions, coins, uses, notes: notes.slice(0, 80), extras: extras.slice(0, 60),
            remaining: br.remainingStatuses,
            statusesSeen: [...new Set(br.statusApplications.map((s) => s.statusId))],
          };
        }
        per[tier] = { entries, modes };
      }
      // handler approx notes for this identity's skills, passives, and statuses touched
      const skillIds = new Set<number>(idt.skillPool.map((r) => r.skillId));
      for (const d of (idt as unknown as { defenseSkillIds?: number[] }).defenseSkillIds ?? []) skillIds.add(d);
      const scripts: Record<string, { handler: string | null; approx?: string; summary?: string }> = {};
      for (const sid of skillIds) {
        const s = core.skills[String(sid)] as unknown as { abilityScripts?: { scriptName: string }[]; coins?: { abilityScriptList?: { scriptName: string }[] }[] };
        if (!s) continue;
        const names = [...(s.abilityScripts ?? []), ...(s.coins ?? []).flatMap((c) => c.abilityScriptList ?? [])].map((a) => a.scriptName);
        for (const n of names) {
          const h = scriptHandler(n);
          scripts[`${sid}:${n}`] = { handler: h ? String(h.name) : null, approx: h?.approx, summary: h?.summary };
        }
      }
      const passives: Record<string, unknown> = {};
      for (const pid of (idt as unknown as { battlePassiveIds?: number[] }).battlePassiveIds ?? []) {
        const h = PASSIVES.get(pid);
        passives[pid] = h ? { summary: h.summary, approx: h.approx } : null;
      }
      const statuses = new Set<string>();
      for (const t of Object.values(per) as { modes: Record<string, { statusesSeen: string[] }> }[]) for (const m of Object.values(t.modes)) for (const s of m.statusesSeen) statuses.add(s);
      const abilities: Record<string, unknown> = {};
      for (const sId of statuses) {
        const b = core.buffs[sId] as unknown as { list?: { ability: string }[] } | undefined;
        for (const it of b?.list ?? []) {
          const h = abilityHandler(it.ability);
          abilities[`${sId}:${it.ability}`] = h ? { summary: h.summary, approx: h.approx } : null;
        }
      }
      out[id] = { per, scripts, passives, abilities };
    }
    writeFileSync(outPath, JSON.stringify(out, null, 1));
  }, 900000);
});
