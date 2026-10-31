"""Extract every static-data TextAsset referenced by the *current* Addressables catalog.

Steps
1. Read the active catalog (persistent cached catalog_S1.bin preferred when its hash
   matches the remote build folder; otherwise the shipped StreamingAssets catalog.bin).
2. Find bundle file names for the static-data group (``static_*_assets_all_<hash>.bundle``).
3. Map each bundle to the Unity cache: <cache>/<anything>/<hash>/__data  (verified rule:
   the cache sub-folder equals the content hash embedded in the bundle file name).
4. Dump each TextAsset to data/raw/static-data/<relative path> and write a provenance
   manifest with bundle name, cache path, sha256 of bundle and of each asset.

Read-only with respect to the game and cache directories.
"""
from __future__ import annotations

import hashlib
import re
import warnings
from pathlib import Path

import UnityPy

from common import RAW_DIR, REPORTS_DIR, load_config, sha256_file, write_json

warnings.filterwarnings("ignore", category=UserWarning)
BUNDLE_RE = re.compile(rb"(static_[a-z0-9_]*?_assets_all_([0-9a-f]{32})\.bundle)")
STATIC_PREFIX = "Assets/Resources_moved/StaticData/"


def detect_unity_version(game: Path) -> str:
    data = (game / "LimbusCompany_Data" / "globalgamemanagers").read_bytes()[:4096]
    m = re.search(rb"(?:20\d\d|6000)\.\d+\.\d+[a-z]\d+", data)
    if not m:
        raise RuntimeError("Unity version not found in globalgamemanagers")
    return m.group().decode()


def active_catalog(cfg) -> Path:
    cached = cfg["_persistent"] / "com.unity.addressables" / "catalog_S1.bin"
    shipped = cfg["_gameRoot"] / "LimbusCompany_Data" / "StreamingAssets" / "aa" / "catalog.bin"
    # The game downloads the remote catalog into persistentDataPath; it supersedes the
    # shipped one when present. Both are recorded in snapshot.json for audit.
    return cached if cached.exists() else shipped


def find_cache_bundle(cache_root: Path, content_hash: str) -> Path | None:
    hits = [d / content_hash / "__data" for d in cache_root.iterdir()
            if d.is_dir() and (d / content_hash / "__data").exists()]
    if len(hits) > 1:
        raise RuntimeError(f"ambiguous cache entries for {content_hash}: {hits}")
    return hits[0] if hits else None


def main() -> None:
    cfg = load_config()
    UnityPy.config.FALLBACK_UNITY_VERSION = detect_unity_version(cfg["_gameRoot"])
    catalog = active_catalog(cfg)
    blob = catalog.read_bytes()
    bundles = sorted({(m.group(1).decode(), m.group(2).decode()) for m in BUNDLE_RE.finditer(blob)})
    if not bundles:
        raise RuntimeError(f"no static bundle referenced by {catalog}")

    out_root = RAW_DIR  # container paths already start with "static-data/"
    import shutil
    shutil.rmtree(RAW_DIR / "static-data", ignore_errors=True)  # only our own output
    manifest = {"catalog": str(catalog).replace("\\", "/"), "catalogSha256": sha256_file(catalog),
                "unityVersion": UnityPy.config.FALLBACK_UNITY_VERSION, "bundles": [], "assets": {}}
    missing = []
    for bundle_name, content_hash in bundles:
        src = find_cache_bundle(cfg["_unityCache"], content_hash)
        if src is None:
            # Might ship in StreamingAssets instead of the download cache.
            local = list((cfg["_gameRoot"] / "LimbusCompany_Data" / "StreamingAssets" / "aa").rglob(bundle_name))
            src = local[0] if local else None
        if src is None:
            missing.append(bundle_name)
            continue
        env = UnityPy.load(str(src))
        count = 0
        for container_path, obj in sorted(env.container.items()):
            if obj.type.name != "TextAsset":
                continue
            data = obj.read().m_Script
            raw = data.encode("utf-8", "surrogateescape") if isinstance(data, str) else bytes(data)
            rel = container_path[len(STATIC_PREFIX):] if container_path.startswith(STATIC_PREFIX) else container_path
            dest = out_root / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(raw)
            manifest["assets"][rel] = {"bundle": bundle_name, "container": container_path,
                                       "sha256": hashlib.sha256(raw).hexdigest(), "size": len(raw)}
            count += 1
        manifest["bundles"].append({"name": bundle_name, "contentHash": content_hash,
                                    "source": str(src).replace("\\", "/"), "sha256": sha256_file(src),
                                    "textAssets": count})
        print(f"{bundle_name}: {count} TextAssets <- {src}")
    manifest["missingBundles"] = missing
    write_json(REPORTS_DIR / "raw-manifest.json", manifest)
    if missing:
        print("MISSING bundles (launch the game once to download them):", missing)


if __name__ == "__main__":
    main()
