"""Loopback-only local preview and stateless Python computation API."""
from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import socket
from pathlib import Path
import sys
import threading
import webbrowser

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, catalog, **kwargs):
        self.catalog = catalog
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def _json(self, status, data):
        body = json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/runtime-config.json":
            return self._json(200, {"compute": "python", "api_version": 2, "model_version": "residual-items-v2"})
        if path == "/api/health":
            return self._json(200, {"ok": True, "compute": "python", "box_id": "54.0", "model_version": "residual-items-v2", "schema_version": 2})
        if path.startswith("/api/"):
            return self._json(404, {"ok": False, "error": {"code": "NOT_FOUND", "message": "Unknown API endpoint"}})
        return super().do_GET()

    def do_POST(self):
        if self.path != "/api/dispatch":
            return self._json(404, {"ok": False, "error": {"code": "NOT_FOUND", "message": "Unknown API endpoint"}})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 2_000_000:
                raise ValueError("Request body must be 1..2000000 bytes")
            if self.headers.get_content_type() != "application/json":
                raise ValueError("Content-Type must be application/json")
            request = json.loads(self.rfile.read(length).decode("utf-8"))
            # The engine receives the local versioned catalog, never one supplied by a request.
            from engine import dispatch
            result = dispatch(request, self.catalog)
            return self._json(200, {"ok": True, "result": result})
        except (ValueError, TypeError, KeyError, OverflowError) as exc:
            return self._json(400, {"ok": False, "error": {"code": getattr(exc, "code", "INVALID_REQUEST"), "message": str(exc)}})
        except Exception:
            self.log_error("Unexpected computation error")
            return self._json(500, {"ok": False, "error": {"code": "COMPUTATION_ERROR", "message": "计算失败，请检查输入或查看本机控制台。"}})


class LoopbackHTTPServer(ThreadingHTTPServer):
    # HTTPServer enables address reuse by default. On Windows that can let a
    # second local preview bind the same endpoint instead of reporting conflict.
    allow_reuse_address = False
    allow_reuse_port = False

    def server_bind(self):
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        return super().server_bind()


def create_server(port=8765):
    catalog = json.loads((PUBLIC / "data" / "box54.json").read_text(encoding="utf-8-sig"))
    return LoopbackHTTPServer(("127.0.0.1", port), partial(Handler, catalog=catalog))


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open-browser", action="store_true")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port must be 1024..65535")
    try:
        server = create_server(args.port)
    except OSError as exc:
        print(f"无法启动端口 {args.port}: {exc}\n可使用 --port 8766 选择其他本机端口。", file=sys.stderr)
        return 1
    url = f"http://127.0.0.1:{server.server_port}/"
    print(f"54.0 本地测试版\n{url}\n仅监听本机 127.0.0.1；Ctrl+C 关闭。", flush=True)
    if args.open_browser:
        threading.Timer(0.3, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
