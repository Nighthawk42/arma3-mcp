"""
Register arma-mcp with the local AI coding tools.

Each tool keeps its MCP config in a different place and format, so this merges
into the existing file rather than replacing it, and backs up first. Re-running
is safe: an existing arma-mcp entry is updated in place.

  python scripts/register-mcp.py            # apply
  python scripts/register-mcp.py --dry-run  # show what would change

Claude Code is handled by its own CLI (`claude mcp add`), not here.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

NAME = "arma-mcp"
# Absolute paths throughout: GUI-launched IDEs do not inherit a shell PATH.
NODE = r"D:\Dev\nodejs\node.exe"
ENTRY = str(Path(__file__).resolve().parent.parent / "dist" / "index.js")

HOME = Path(os.environ.get("USERPROFILE") or Path.home())
DRY_RUN = "--dry-run" in sys.argv

TARGETS_JSON = {
    "omp": HOME / ".omp" / "agent" / "mcp.json",
    "antigravity": HOME / ".gemini" / "antigravity" / "mcp_config.json",
}
CODEX_TOML = HOME / ".codex" / "config.toml"


def backup(path: Path) -> None:
    if DRY_RUN or not path.exists():
        return
    stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
    shutil.copy2(path, path.with_suffix(path.suffix + f".{stamp}.bak"))


def register_json(label: str, path: Path) -> str:
    if not path.exists():
        return f"{label}: SKIPPED (no config at {path})"

    # Some of these files are written by PowerShell and carry a UTF-8 BOM;
    # utf-8-sig round-trips it either way.
    raw = path.read_text(encoding="utf-8-sig")
    had_bom = path.read_bytes().startswith(b"\xef\xbb\xbf")
    config = json.loads(raw)

    servers = config.setdefault("mcpServers", {})
    existed = NAME in servers
    servers[NAME] = {"command": NODE, "args": [ENTRY]}

    if not DRY_RUN:
        backup(path)
        path.write_text(
            json.dumps(config, indent=2) + "\n",
            encoding="utf-8-sig" if had_bom else "utf-8",
        )
    verb = "updated" if existed else "added"
    return f"{label}: {verb} ({len(servers)} servers) -> {path}"


def register_codex(path: Path) -> str:
    """Codex uses TOML; append a section rather than rewriting the file."""
    if not path.exists():
        return f"codex: SKIPPED (no config at {path})"

    text = path.read_text(encoding="utf-8")
    section = f"[mcp_servers.{NAME}]"

    # TOML literal strings (single quotes) — a basic "..." string would treat
    # the backslashes in a Windows path as escapes, turning D:\Dev\nodejs into
    # a string containing a newline and corrupting the file.
    entry = (
        f"\n{section}\n"
        f"command = '{NODE}'\n"
        f"args = ['{ENTRY}']\n"
    )

    if section in text:
        # Replace the existing block up to the next top-level section.
        pattern = re.compile(
            rf"\n\[mcp_servers\.{re.escape(NAME)}\][^\[]*", re.MULTILINE
        )
        new_text = pattern.sub(entry, text, count=1)
        verb = "updated"
    else:
        new_text = text.rstrip("\n") + "\n" + entry
        verb = "added"

    if not DRY_RUN:
        backup(path)
        path.write_text(new_text, encoding="utf-8")
    return f"codex: {verb} -> {path}"


def main() -> int:
    if not Path(ENTRY).exists():
        print(f"ERROR: {ENTRY} not found — run `npm run build` first.")
        return 1

    print(f"{'DRY RUN — ' if DRY_RUN else ''}registering {NAME}")
    print(f"  command: {NODE}")
    print(f"  entry:   {ENTRY}\n")

    for label, path in TARGETS_JSON.items():
        try:
            print("  " + register_json(label, path))
        except Exception as exc:  # noqa: BLE001 - report and continue
            print(f"  {label}: FAILED — {exc}")

    try:
        print("  " + register_codex(CODEX_TOML))
    except Exception as exc:  # noqa: BLE001
        print(f"  codex: FAILED — {exc}")

    print("\n  claude: use `claude mcp add` (handled by its own CLI)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
