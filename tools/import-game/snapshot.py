"""Record a read-only snapshot manifest of every input the importer depends on.

Output: data/reports/snapshot.json
Re-running with unchanged inputs yields byte-identical output (no wall-clock fields
except the per-file mtime that already lives on disk).
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

from common import REPORTS_DIR, load_config, read_json_lenient, sha256_file, write_json


def file_entry(path: Path, base: Path | None = None) -> dict:
    st = path.stat()
    return {
        "path": str(path.relative_to(base)).replace("\\", "/") if base else str(path).replace("\\", "/"),
        "size": st.st_size,
        "mtime": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(timespec="seconds"),
        "sha256": sha256_file(path),
    }


def walk_files(root: Path, exclude: set[str], suffixes: tuple[str, ...] | None = None):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in exclude)
        for name in sorted(filenames):
            if suffixes is None or name.lower().endswith(suffixes):
                yield Path(dirpath) / name


def main() -> None:
    cfg = load_config()
    game: Path = cfg["_gameRoot"]
    aa = game / "LimbusCompany_Data" / "StreamingAssets" / "aa"
    settings = read_json_lenient(aa / "settings.json")
    build_dirs = sorted(p.name for p in aa.iterdir() if p.is_dir() and p.name.startswith("s"))
    remote_hash_url = next(
        (loc["m_InternalId"] for loc in settings["m_CatalogLocations"]
         if "AddressablesMainContentCatalogRemoteHash" in loc["m_Keys"]), None)

    persistent_aa = cfg["_persistent"] / "com.unity.addressables"
    core = [
        game / "GameAssembly.dll",
        game / "LimbusCompany_Data" / "il2cpp_data" / "Metadata" / "global-metadata.dat",
        aa / "settings.json",
        aa / "catalog.bin",
        aa / "catalog.hash",
    ]
    cached_catalog = [p for p in sorted(persistent_aa.glob("catalog_*")) if p.is_file()]

    translation = {}
    for pack, root in cfg["_packs"].items():
        if root.exists():
            translation[pack] = [file_entry(p, root) for p in walk_files(root, cfg["_exclude"], (".json",))]
    localize = []
    if cfg["_localize"].exists():
        localize = [file_entry(p, cfg["_localize"]) for p in walk_files(cfg["_localize"], cfg["_exclude"])]

    cache_root: Path = cfg["_unityCache"]
    cache_bundle_names = sorted(p.name for p in cache_root.iterdir() if p.is_dir()) if cache_root.exists() else []

    manifest = {
        "formatVersion": 1,
        "build": {
            "addressablesVersion": settings.get("m_AddressablesVersion"),
            "buildTarget": settings.get("m_buildTarget"),
            "settingsHash": settings.get("m_SettingsHash"),
            "streamingBuildDirs": build_dirs,
            "remoteCatalogHashUrl": remote_hash_url,
            "localCatalogHash": (aa / "catalog.hash").read_text().strip(),
            "cachedCatalogHash": next(
                (p.read_text().strip() for p in cached_catalog if p.suffix == ".hash"), None),
        },
        "core": [file_entry(p) for p in core if p.exists()],
        "cachedCatalog": [file_entry(p) for p in cached_catalog],
        "translationPacks": translation,
        "originalLocalize": localize,
        "unityCache": {"root": str(cache_root).replace("\\", "/"), "bundleDirCount": len(cache_bundle_names)},
    }
    out = REPORTS_DIR / "snapshot.json"
    write_json(out, manifest)
    print(f"wrote {out}")
    print("build:", manifest["build"])
    print({k: len(v) for k, v in translation.items()}, "localize files:", len(localize))


if __name__ == "__main__":
    main()
