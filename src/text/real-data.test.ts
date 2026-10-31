import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRichText } from "./rich-text";

// Runs against the locally built bundle (pnpm data). Skipped when game data is not present.
const dir = new URL("../../public/data/text/", import.meta.url);
const packs = ["LLC_zh-CN", "ST", "en"].filter((p) => existsSync(new URL(`${p}.json`, dir)));

describe.skipIf(packs.length === 0)("rich text over real translation packs", () => {
  for (const pack of packs) {
    it(`${pack}: all texts parse, keywords resolve`, () => {
      const t = JSON.parse(readFileSync(new URL(`${pack}.json`, dir), "utf8"));
      const texts: string[] = [];
      for (const s of Object.values<any>(t.skills)) texts.push(s.desc ?? "", ...s.coins.flatMap((c: any) => c.descs));
      for (const cat of ["passives", "bufs", "keywords", "buffAbilities"]) {
        for (const r of Object.values<any>(t[cat])) texts.push(r.desc ?? "", r.summary ?? "");
      }
      const known = new Set([...Object.keys(t.bufs), ...Object.keys(t.keywords), ...Object.keys(t.skillTags)]);
      let diags = 0;
      const unresolved = new Map<string, number>();
      const samples: string[] = [];
      for (const x of texts) {
        const r = parseRichText(x);
        diags += r.diagnostics.length;
        if (r.diagnostics.length && samples.length < 5) samples.push(r.diagnostics[0]!);
        for (const run of r.runs) {
          if (run.kind === "keyword" && !known.has(run.id)) unresolved.set(run.id, (unresolved.get(run.id) ?? 0) + 1);
        }
      }
      console.log(pack, { texts: texts.length, diagnostics: diags, samples, unresolved: [...unresolved].slice(0, 10) });
      expect(diags / texts.length).toBeLessThan(0.01);
    });
  }
});
