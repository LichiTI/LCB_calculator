// Bundle data/normalized into public/data for the browser app.
// core.json: identities, skills, passives, buffs (+ manifest). text/<pack>.json: per translation pack.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const norm = join(root, "data", "normalized");
const out = join(root, "public", "data");
const read = (p) => JSON.parse(readFileSync(p, "utf8"));

for (const f of ["identities.json", "skills.json", "passives.json", "buffs.json"]) {
  if (!existsSync(join(norm, f))) {
    console.error(`missing ${f}: run "python tools/import-game/run_all.py" first`);
    process.exit(1);
  }
}

const identities = read(join(norm, "identities.json"));
const skills = { ...read(join(norm, "skills.json")) };
const passives = { ...read(join(norm, "passives.json")) };
const buffs = read(join(norm, "buffs.json"));
const egosPath = join(norm, "egos.json");
const egosBundle = existsSync(egosPath) ? read(egosPath) : { egos: [], skills: {}, passives: {} };
const egos = egosBundle.egos ?? [];
Object.assign(skills, egosBundle.skills ?? {});
Object.assign(passives, egosBundle.passives ?? {});
const snapshotPath = join(root, "data", "reports", "snapshot.json");
const snapshot = existsSync(snapshotPath) ? read(snapshotPath) : null;

// Strip bulky fields the UI does not need.
for (const s of Object.values(skills)) delete s.fieldSourceLevel;
for (const p of Object.values(passives)) delete p.raw;
for (const i of identities) delete i.mentalConditionInfo;

const coreBody = JSON.stringify({ identities, egos, skills, passives, buffs });
const contentHash = createHash("sha256").update(coreBody).digest("hex").slice(0, 16);
const build = snapshot?.build?.streamingBuildDirs?.[0] ?? "unknown";
const manifest = {
  dataVersion: `${build}+${contentHash}`,
  build,
  catalogHash: snapshot?.build?.cachedCatalogHash ?? null,
  uptie: 4,
};

rmSync(join(out, "text"), { recursive: true, force: true });
mkdirSync(join(out, "text"), { recursive: true });
writeFileSync(join(out, "core.json"), JSON.stringify({ manifest, identities, egos, skills, passives, buffs }));

const packs = [];
for (const f of readdirSync(join(norm, "text")).sort()) {
  if (!f.endsWith(".json")) continue;
  writeFileSync(join(out, "text", f), JSON.stringify(read(join(norm, "text", f))));
  packs.push(f.replace(/\.json$/, ""));
}
writeFileSync(join(out, "packs.json"), JSON.stringify(packs));
console.log(`public/data: ${identities.length} identities, ${egos.length} egos, ${Object.keys(skills).length} skills, packs=${packs.join(",")}, dataVersion=${manifest.dataVersion}`);
