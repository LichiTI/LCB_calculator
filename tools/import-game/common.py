"""Shared helpers for the read-only game importer."""
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = PROJECT_ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
NORMALIZED_DIR = DATA_DIR / "normalized"
REPORTS_DIR = DATA_DIR / "reports"


def _expand(value: str) -> Path:
    return Path(os.path.expandvars(value)).expanduser()


GAME_MARKER = "LimbusCompany_Data"
BUILTIN_LANGS = {"en", "kr", "jp"}
MIN_PACK_JSON = 100  # a real translation pack has thousands of json files; skip work/backup folders


def _steam_libraries() -> list[Path]:
    """Steam library roots from the registry + libraryfolders.vdf (Windows only, best effort)."""
    roots: list[Path] = []
    try:
        import winreg  # type: ignore

        for hive, key in ((winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam"), (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Valve\Steam")):
            try:
                with winreg.OpenKey(hive, key) as k:
                    for name in ("SteamPath", "InstallPath"):
                        try:
                            roots.append(Path(winreg.QueryValueEx(k, name)[0]))
                        except OSError:
                            pass
            except OSError:
                pass
    except ImportError:
        pass
    libs: list[Path] = []
    for r in roots:
        libs.append(r)
        vdf = r / "steamapps" / "libraryfolders.vdf"
        if vdf.exists():
            for m in re.finditer(r'"path"\s+"([^"]+)"', vdf.read_text(encoding="utf-8", errors="ignore")):
                libs.append(Path(m.group(1).replace("\\\\", "\\")))
    return libs


def detect_game_root(value: str | None) -> Path:
    """Resolve the game folder. "auto" tries: env LIMBUS_GAME_ROOT, the folder above this project, Steam libraries."""
    candidates: list[Path] = []
    if value and value.strip().lower() != "auto":
        candidates.append(_expand(value))
    if os.environ.get("LIMBUS_GAME_ROOT"):
        candidates.append(_expand(os.environ["LIMBUS_GAME_ROOT"]))
    candidates.append(PROJECT_ROOT.parent)
    candidates += [lib / "steamapps" / "common" / "Limbus Company" for lib in _steam_libraries()]
    for c in candidates:
        if (c / GAME_MARKER).is_dir():
            return c
    tried = "\n  ".join(str(c) for c in candidates)
    raise FileNotFoundError(
        f"找不到 Limbus Company 游戏目录（需含 {GAME_MARKER}）。已尝试：\n  {tried}\n"
        "请在 local.config.json 的 gameRoot 填写游戏目录，或设置环境变量 LIMBUS_GAME_ROOT。"
    )


def _pack_name(raw: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\s]+', "_", raw).strip("._") or "pack"
    return f"Lang_{name}" if name in BUILTIN_LANGS else name


def discover_packs(lang_dir: Path, exclude: set[str]) -> dict[str, Path]:
    """Every folder under LimbusCompany_Data/Lang that looks like a translation pack."""
    packs: dict[str, Path] = {}
    if not lang_dir.is_dir():
        return packs
    for d in sorted(lang_dir.iterdir()):
        if not d.is_dir() or d.name in exclude or d.name.startswith(("_", ".")):
            continue
        count = 0
        for _ in d.rglob("*.json"):
            count += 1
            if count >= MIN_PACK_JSON:
                break
        if count >= MIN_PACK_JSON:
            packs[_pack_name(d.name)] = d
    return packs


def load_config() -> dict:
    """Load local.config.json, falling back to the example file.

    gameRoot: "auto" or a path.  translationPacks: "auto" (scan LimbusCompany_Data/Lang) or {name: path};
    relative pack paths are relative to the game folder, absolute paths may point anywhere.
    extraTranslationPacks: {name: path} merged on top (e.g. a translation kept outside the game folder).
    """
    cfg: dict = {}
    for name in ("local.config.json", "local.config.example.json"):
        path = PROJECT_ROOT / name
        if path.exists():
            cfg = json.loads(path.read_text(encoding="utf-8-sig"))
            break
    game = detect_game_root(cfg.get("gameRoot", "auto"))
    cfg["_gameRoot"] = game
    cfg["_persistent"] = _expand(cfg.get("persistentDataPath", "%USERPROFILE%/AppData/LocalLow/ProjectMoon/LimbusCompany"))
    cfg["_unityCache"] = _expand(cfg.get("unityCachePath", "%USERPROFILE%/AppData/LocalLow/Unity/ProjectMoon_LimbusCompany"))
    cfg["_exclude"] = set(cfg.get("excludeDirNames", []))
    tp = cfg.get("translationPacks", "auto")
    if isinstance(tp, dict):
        packs = {_pack_name(k): game / _expand(v) for k, v in tp.items()}
    else:
        packs = discover_packs(game / GAME_MARKER / "Lang", cfg["_exclude"])
    for k, v in (cfg.get("extraTranslationPacks") or {}).items():
        packs[_pack_name(k)] = game / _expand(v)
    cfg["_packs"] = {k: v for k, v in packs.items() if v.is_dir()}
    cfg["_localize"] = game / cfg.get("originalLocalize", "LimbusCompany_Data/Assets/Resources_moved/Localize")
    return cfg


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while block := f.read(chunk):
            h.update(block)
    return h.hexdigest()


def write_json(path: Path, obj, *, sort_keys: bool = True) -> None:
    """Deterministic JSON output (stable key order, LF, UTF-8)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=sort_keys)
    path.write_text(text + "\n", encoding="utf-8", newline="\n")


def read_json_lenient(path: Path):
    """Game/translation JSON may carry a BOM."""
    return json.loads(path.read_text(encoding="utf-8-sig"))
