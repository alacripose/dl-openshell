"""Local witness for the release downloader's retry path.

Serves on loopback: the first request for the asset is closed without a response (the CDN
behaviour that aborted the install), every later request returns the seven-byte payload. Then it
runs the PowerShell harness twice: once against this flaky port and once against a port nothing
listens on.
"""

import http.server
import socket
import subprocess
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
TESTS = Path(__file__).resolve().parent / "download-retry-test.ps1"
PAYLOAD = b"PAYLOAD"


class Flaky(http.server.BaseHTTPRequestHandler):
    requests = 0

    def do_GET(self):  # noqa: N802 - http.server API
        type(self).requests += 1
        if type(self).requests == 1:
            # Drop the connection mid-request with no status line, which is what aborted the
            # release install. The client sees "connection was closed unexpectedly".
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.close_connection = True
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(PAYLOAD)))
        self.end_headers()
        self.wfile.write(PAYLOAD)

    def log_message(self, *_args):
        return


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def main() -> int:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Flaky)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    dead_port = free_port()  # bound then closed: nothing listens here
    print(f"flaky server on 127.0.0.1:{port}; dead port {dead_port}")
    try:
        result = subprocess.run(
            [
                "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(TESTS),
                "-Flaky", f"http://127.0.0.1:{port}", "-Dead", f"http://127.0.0.1:{dead_port}",
            ],
            cwd=str(ROOT), text=True, encoding="utf-8", errors="replace", check=False,
        )
    finally:
        server.shutdown()
    print(f"requests seen: {Flaky.requests} (first was dropped)")
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
