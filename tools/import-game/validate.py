"""Validate normalized data against data/normalized/schema/*.schema.json."""
from __future__ import annotations

import json
import sys

from jsonschema import Draft202012Validator

from common import NORMALIZED_DIR

TARGETS = {"identities.json": "identity.schema.json", "skills.json": "skill.schema.json"}


def main() -> int:
    failures = 0
    for data_name, schema_name in TARGETS.items():
        schema = json.loads((NORMALIZED_DIR / "schema" / schema_name).read_text(encoding="utf-8"))
        validator = Draft202012Validator(schema)
        data = json.loads((NORMALIZED_DIR / data_name).read_text(encoding="utf-8"))
        items = data.values() if isinstance(data, dict) else data
        bad = 0
        for item in items:
            errs = list(validator.iter_errors(item))
            if errs:
                bad += 1
                if bad <= 5:
                    print(f"{data_name} id={item.get('id')}: {errs[0].json_path} {errs[0].message}")
        print(f"{data_name}: {len(list(items)) if isinstance(data, list) else len(data)} records, {bad} invalid")
        failures += bad
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
