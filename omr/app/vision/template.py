import json
from pathlib import Path

TEMPLATE = json.loads((Path(__file__).parent / "template.json").read_text(encoding="utf-8"))
