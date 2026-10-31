"""Build per-pack localized text indexes linked by stable IDs.

Load order comes from Localize/RemoteLocalizeFileList.json (the game's own per-category
file list). Files present in a pack but absent from that list are reported, not loaded.
Duplicate IDs inside one pack are reported; differing duplicates are kept as conflicts
(the later file in load order is shown, flagged ``conflict``) - never merged.

Skill text at uptie IV = the levelList entry with the highest level <= 4 (text levels are
full snapshots; e.g. 1010501 has text levels 1/2/4 while data level 3 only changes power).

Outputs: data/normalized/text/<pack>.json, data/reports/text-coverage.json
"""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

from common import NORMALIZED_DIR, REPORTS_DIR, load_config, read_json_lenient, write_json

UPTIE = 4
CATEGORIES = ["personality", "ego", "skill", "passive", "buf", "buffAbilities", "keyword", "skillTag"]


def pack_sources(cfg) -> dict[str, tuple[Path, str]]:
    """pack name -> (directory, filename prefix)."""
    packs = {name: (path, "") for name, path in cfg["_packs"].items()}
    for lang, prefix in (("en", "EN_"), ("kr", "KR_"), ("jp", "JP_")):
        packs[lang] = (cfg["_localize"] / lang, prefix)
    return packs


def pick_level(level_list: list[dict]) -> dict | None:
    eligible = [lv for lv in level_list or [] if lv.get("level", 1) <= UPTIE]
    return max(eligible, key=lambda lv: lv.get("level", 1)) if eligible else None


def build_pack(name: str, root: Path, prefix: str, load_list: dict, exclude: set) -> tuple[dict, dict]:
    out = {c: {} for c in CATEGORIES}
    meta = {"missingFiles": [], "duplicates": Counter(), "conflicts": [], "unlistedFiles": [], "badFiles": []}
    listed = set()
    for cat in CATEGORIES:
        for base in load_list.get(cat, []):
            fname = f"{prefix}{base}.json"
            listed.add(fname.lower())
            path = root / fname
            if not path.exists():
                meta["missingFiles"].append(fname)
                continue
            try:
                data = read_json_lenient(path)
            except Exception as exc:  # malformed translation file must not abort the import
                meta["badFiles"].append({"file": fname, "error": str(exc)[:200]})
                continue
            for rec in data.get("dataList", []) if isinstance(data, dict) else []:
                if not isinstance(rec, dict) or "id" not in rec:
                    continue
                key = str(rec["id"])
                entry = {**rec, "_file": fname}
                if key in out[cat]:
                    prev = out[cat][key]
                    same = {k: v for k, v in prev.items() if k not in ("_file", "conflict")} == rec
                    meta["duplicates"][(cat, same)] += 1
                    if not same:
                        meta["conflicts"].append({"category": cat, "id": key, "files": [prev["_file"], fname]})
                        entry["conflict"] = True
                    else:
                        continue
                out[cat][key] = entry
    # files that look like battle text but are not in the game's load list
    prefixes = tuple(f"{prefix}{p}".lower() for p in ("Skills", "Passive", "Bufs", "BattleKeywords", "Personalities"))
    if root.exists():
        for p in sorted(root.iterdir()):
            if p.is_file() and p.suffix == ".json" and p.name.lower().startswith(prefixes) \
                    and p.name.lower() not in listed:
                meta["unlistedFiles"].append(p.name)
    meta["duplicates"] = {f"{c}:{'identical' if s else 'different'}": n for (c, s), n in meta["duplicates"].items()}
    return out, meta


def shape(out: dict, ids: dict) -> dict:
    """Keep only what the calculator needs, with uptie-IV skill text resolved."""
    skills = {}
    for sid in ids["skills"]:
        rec = out["skill"].get(sid)
        if not rec:
            continue
        lv = pick_level(rec.get("levelList"))
        if lv is None:
            continue
        skills[sid] = {"name": lv.get("name"), "desc": lv.get("desc", ""), "level": lv.get("level", 1),
                       "coins": [{"descs": [d.get("desc", "") for d in c.get("coindescs", [])]}
                                 for c in lv.get("coinlist", [])],
                       "file": rec["_file"], **({"conflict": True} if rec.get("conflict") else {})}
    def strip(cat, keep):
        return {k: {f: v for f, v in r.items() if f in keep} for k, r in out[cat].items()}
    personalities = {k: v for k, v in strip("personality", {"title", "name", "nameWithTitle", "desc", "_file"}).items()
                     if k in ids["identities"]}
    egos = {k: v for k, v in strip("ego", {"name", "desc", "_file", "conflict"}).items()
            if k in ids.get("egos", set())}
    passives = {k: v for k, v in strip("passive", {"name", "desc", "summary", "_file", "conflict"}).items()
                if k in ids["passives"]}
    return {"personalities": personalities, "egos": egos, "skills": skills, "passives": passives,
            "bufs": strip("buf", {"name", "desc", "summary", "_file", "conflict"}),
            "buffAbilities": strip("buffAbilities", {"desc", "_file"}),
            "keywords": strip("keyword", {"name", "desc", "summary", "_file", "conflict"}),
            "skillTags": strip("skillTag", {"name", "_file"})}


def main() -> None:
    cfg = load_config()
    load_list = read_json_lenient(cfg["_localize"] / "RemoteLocalizeFileList.json")
    identities = json.loads((NORMALIZED_DIR / "identities.json").read_text(encoding="utf-8"))
    skills = json.loads((NORMALIZED_DIR / "skills.json").read_text(encoding="utf-8"))
    passives = json.loads((NORMALIZED_DIR / "passives.json").read_text(encoding="utf-8"))
    buffs = json.loads((NORMALIZED_DIR / "buffs.json").read_text(encoding="utf-8"))
    egos_bundle = json.loads((NORMALIZED_DIR / "egos.json").read_text(encoding="utf-8")) if (NORMALIZED_DIR / "egos.json").exists() else {"egos": [], "skills": {}, "passives": {}}
    ids = {
        "identities": {str(i["id"]) for i in identities},
        "egos": {str(e["id"]) for e in egos_bundle.get("egos", [])},
        "skills": set(skills) | set(egos_bundle.get("skills", {})),
        "passives": set(passives) | set(egos_bundle.get("passives", {})),
    }

    referenced_buffs = set()
    for s in skills.values():
        for sc in s["abilityScripts"] + [x for c in s["coins"] for x in c.get("abilityScriptList", [])]:
            kw = (sc.get("buffData") or {}).get("buffKeyword")
            if kw:
                referenced_buffs.add(kw)

    coverage = {}
    shaped_all = {}
    text_dir = NORMALIZED_DIR / "text"
    if text_dir.is_dir():  # drop packs that no longer exist
        for old in text_dir.glob("*.json"):
            old.unlink()
    sources = pack_sources(cfg)
    print("translation packs:", ", ".join(f"{n} <- {r}" for n, (r, _) in sources.items()))
    for name, (root, prefix) in sources.items():
        out, meta = build_pack(name, root, prefix, load_list, cfg["_exclude"])
        if not out.get("personality") and not out.get("skill"):
            print(f"skip {name}: no personality/skill text in {root} (not a translation pack in the game's Lang layout)")
            continue
        shaped = shape(out, ids)
        shaped_all[name] = shaped
        write_json(NORMALIZED_DIR / "text" / f"{name}.json", shaped)
        coverage[name] = {
            "root": str(root).replace("\\", "/"),
            "loadedCounts": {c: len(v) for c, v in out.items()},
            "missing": {
                "identities": sorted(ids["identities"] - set(shaped["personalities"]), key=int),
                "skills": sorted(ids["skills"] - set(shaped["skills"]), key=int),
                "passives": sorted(ids["passives"] - set(shaped["passives"]), key=int),
                "referencedBufs": sorted(b for b in referenced_buffs
                                         if b not in shaped["bufs"] and b not in shaped["keywords"]),
            },
            **meta,
        }
        m = coverage[name]["missing"]
        print(f"{name:10s} loaded={coverage[name]['loadedCounts']} missing: identities={len(m['identities'])} "
              f"skills={len(m['skills'])} passives={len(m['passives'])} bufs={len(m['referencedBufs'])} "
              f"missingFiles={len(meta['missingFiles'])} unlisted={len(meta['unlistedFiles'])} "
              f"conflicts={len(meta['conflicts'])} bad={len(meta['badFiles'])}")

    # Translation diff: entries present in English but absent from each pack
    en = shaped_all.get("en", {})
    for name, shaped in shaped_all.items():
        if name == "en":
            continue
        coverage[name]["absentVsEn"] = {cat: sorted(set(en.get(cat, {})) - set(shaped.get(cat, {})))
                                        for cat in ("skills", "passives", "bufs", "keywords", "personalities")}
    write_json(REPORTS_DIR / "text-coverage.json", coverage)


if __name__ == "__main__":
    main()
