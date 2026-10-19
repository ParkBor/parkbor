"""Static check of the Maestro flows (no device, no Maestro CLI needed).

    python mobile/e2e/scripts/validate_flows.py

Checks per file: valid YAML, two documents (config, commands), appId, name/tags on top-level flows,
only known Maestro commands, runFlow / runScript targets exist, every `id:` selector is listed in
TESTID_REQUESTS.md, node scripts parse. It proves syntax and wiring ONLY. Nothing here runs the app.
"""

import re
import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
APP_ID = "uz.parkbor.app"
KNOWN_TAGS = {"smoke", "full", "android", "security", "needs-testids", "needs-hook"}
KNOWN_COMMANDS = {
    "tapOn", "assertVisible", "assertNotVisible", "inputText", "eraseText", "hideKeyboard",
    "extendedWaitUntil", "runFlow", "runScript", "evalScript", "launchApp", "stopApp", "clearState",
    "clearKeychain", "openLink", "scrollUntilVisible", "setLocation", "setAirplaneMode",
    "takeScreenshot", "waitForAnimationToEnd", "copyTextFrom", "back", "pressKey", "repeat",
}


def commands_of(doc) -> list:
    return doc if isinstance(doc, list) else []


def walk(commands: list):
    """Yield (name, argument) for every command, descending into nested command lists."""
    for item in commands:
        if isinstance(item, str):
            yield item, None
            continue
        if not isinstance(item, dict) or len(item) != 1:
            yield "<malformed>", item
            continue
        (name, arg), = item.items()
        yield name, arg
        if isinstance(arg, dict):
            yield from walk(arg.get("commands", []))


def check_file(path: Path, is_top_level: bool, requested_ids: set[str]) -> list[str]:
    errors: list[str] = []
    rel = path.relative_to(ROOT)
    try:
        docs = list(yaml.safe_load_all(path.read_text(encoding="utf-8")))
    except yaml.YAMLError as exc:
        return [f"{rel}: invalid YAML: {exc}"]
    docs = [d for d in docs if d is not None]
    if len(docs) != 2:
        return [f"{rel}: expected a config document, '---', then commands (got {len(docs)} documents)"]
    config, body = docs
    if not isinstance(config, dict) or config.get("appId") != APP_ID:
        errors.append(f"{rel}: appId must be {APP_ID}")
    if is_top_level:
        if not config.get("name"):
            errors.append(f"{rel}: top-level flow needs a name")
        tags = set(config.get("tags") or [])
        if not tags & {"smoke", "full"}:
            errors.append(f"{rel}: needs the tag smoke or full")
        if tags - KNOWN_TAGS:
            errors.append(f"{rel}: unknown tags {sorted(tags - KNOWN_TAGS)}")
    if not isinstance(body, list) or not body:
        return errors + [f"{rel}: command list is empty or not a list"]
    for name, arg in walk(body):
        if name not in KNOWN_COMMANDS:
            errors.append(f"{rel}: unknown or malformed command {name!r}")
        if name == "runFlow":
            target = arg if isinstance(arg, str) else (arg or {}).get("file")
            if target and not (path.parent / target).is_file():
                errors.append(f"{rel}: runFlow target missing: {target}")
        if name == "runScript":
            target = arg if isinstance(arg, str) else (arg or {}).get("file")
            if not target or not (path.parent / target).is_file():
                errors.append(f"{rel}: runScript target missing: {target}")
        if name in {"tapOn", "assertVisible", "assertNotVisible"} and isinstance(arg, dict):
            test_id = arg.get("id")
            if test_id and test_id not in requested_ids:
                errors.append(f"{rel}: id '{test_id}' is not listed in TESTID_REQUESTS.md")
    return errors


def main() -> int:
    requests = (ROOT / "TESTID_REQUESTS.md").read_text(encoding="utf-8")
    requested_ids = set(re.findall(r"`([a-z][a-z0-9-]+)`", requests))
    errors: list[str] = []
    flows = sorted((ROOT / "flows").glob("*.yaml"))
    subflows = sorted((ROOT / "subflows").glob("*.yaml"))
    if not flows:
        errors.append("no flows found")
    for path in flows:
        errors += check_file(path, True, requested_ids)
    for path in subflows:
        errors += check_file(path, False, requested_ids)
    yaml.safe_load((ROOT / "config.yaml").read_text(encoding="utf-8"))
    for script in sorted((ROOT / "scripts").glob("*.js")):
        result = subprocess.run(["node", "--check", str(script)], capture_output=True, text=True)
        if result.returncode != 0:
            errors.append(f"{script.relative_to(ROOT)}: {result.stderr.strip()}")
    for error in errors:
        print(f"ERROR {error}")
    print(f"{len(flows)} flows, {len(subflows)} subflows, {len(errors)} problems")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
