"""config.toml 읽기. 파일이 없으면 기본값으로 동작한다 (손글씨 판독만 꺼짐)."""
import os
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = Path(os.environ.get("OMR_CONFIG", ROOT / "config.toml"))

DEFAULTS = {
    "api": {
        "anthropic_api_key": "",
        "model": "claude-opus-5-5",
        "effort": "medium",
        "use_fallbacks": True,
    },
    "server": {
        "port": 8000,
        "allowed_networks": ["auto"],
    },
    "omr": {
        "filled": 0.38,
        "empty": 0.18,
    },
    "storage": {
        "data_dir": "data",
        "photo_retention_days": 90,
    },
}


def load_config(path: Path = CONFIG_PATH) -> dict:
    cfg = {k: dict(v) for k, v in DEFAULTS.items()}
    if path.exists():
        with open(path, "rb") as f:
            user = tomllib.load(f)
        for section, values in user.items():
            cfg.setdefault(section, {}).update(values)
    if os.environ.get("ANTHROPIC_API_KEY") and not cfg["api"]["anthropic_api_key"]:
        cfg["api"]["anthropic_api_key"] = os.environ["ANTHROPIC_API_KEY"]
    data_dir = Path(os.environ.get("OMR_DATA_DIR", cfg["storage"]["data_dir"]))
    cfg["storage"]["data_path"] = data_dir if data_dir.is_absolute() else ROOT / data_dir
    return cfg
