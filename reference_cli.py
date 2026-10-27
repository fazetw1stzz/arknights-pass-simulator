"""Single JSON stdin/stdout reference transport for JavaScript parity tests."""
import json
import sys

from engine import ModelError, dispatch


def main():
    # Windows redirected streams otherwise use the machine's legacy code page.
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict) or set(payload) != {"catalog", "request"}:
            raise ModelError("INVALID_INPUT", "Expected {catalog, request}")
        response = {"ok": True, "result": dispatch(payload["request"], payload["catalog"])}
    except ModelError as exc:
        response = {"ok": False, "error": {"code": exc.code, "message": str(exc)}}
    except (ValueError, TypeError, OverflowError) as exc:
        response = {"ok": False, "error": {"code": "INVALID_INPUT", "message": str(exc)}}
    sys.stdout.write(json.dumps(response, ensure_ascii=False, allow_nan=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
