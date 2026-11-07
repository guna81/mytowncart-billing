#!/usr/bin/env python3
"""Set the app version everywhere it is recorded: python3 tooling/bump-version.py 0.2.0

Updates every package.json, tauri.conf.json, Cargo.toml, the app's own entry in
Cargo.lock and APP_VERSION, so the release workflow's version check passes.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def sub_once(path: Path, pattern: str, repl: str, flags: int = 0) -> None:
    text = path.read_text()
    new, n = re.subn(pattern, repl, text, count=1, flags=flags)
    if n != 1:
        sys.exit(f"could not find the version in {path}")
    path.write_text(new)


def main() -> None:
    if len(sys.argv) != 2 or not re.fullmatch(r"\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?", sys.argv[1]):
        sys.exit("usage: bump-version.py MAJOR.MINOR.PATCH[-suffix]")
    v = sys.argv[1]
    for pkg in [ROOT / "package.json", *ROOT.glob("apps/*/package.json"), *ROOT.glob("packages/*/package.json")]:
        sub_once(pkg, r'"version":\s*"[^"]+"', f'"version": "{v}"')
    tauri = ROOT / "apps/desktop/src-tauri"
    sub_once(tauri / "tauri.conf.json", r'"version":\s*"[^"]+"', f'"version": "{v}"')
    sub_once(tauri / "Cargo.toml", r'^version\s*=\s*"[^"]+"', f'version = "{v}"', re.M)
    sub_once(tauri / "Cargo.lock", r'(name = "mytowncart-billing"\nversion = )"[^"]+"', rf'\g<1>"{v}"')
    sub_once(ROOT / "packages/core/src/index.ts", r'APP_VERSION = "[^"]+"', f'APP_VERSION = "{v}"')
    print(f"Version set to {v}. Run the checks, commit, push main, then: git tag v{v} && git push origin v{v}")


if __name__ == "__main__":
    main()
