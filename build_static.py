"""Build a local portable browser package. Does not upload or publish anything."""
from pathlib import Path
import json
import shutil

ROOT = Path(__file__).resolve().parent


def main():
    public = ROOT / "public"
    target = (ROOT / "dist").resolve()
    # Never remove any path except this project's exact dist child.
    if target.parent != ROOT or target.name != "dist" or target == ROOT:
        raise RuntimeError("Unsafe static output path")
    if target.exists():
        if target.is_symlink():
            raise RuntimeError("Refusing a symlink output directory")
        shutil.rmtree(target)
    shutil.copytree(public, target)
    (target / "runtime-config.json").write_text(json.dumps({"compute": "client", "api_version": 2, "model_version": "residual-items-v2"}) + "\n", encoding="utf-8")
    files = [p for p in target.rglob("*") if p.is_file()]
    print(json.dumps({"output": str(target), "files": len(files), "bytes": sum(p.stat().st_size for p in files), "published": False}))


if __name__ == "__main__":
    main()
