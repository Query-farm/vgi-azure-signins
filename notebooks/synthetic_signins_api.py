"""Synthetic paged Graph sign-in fixture with a second visibility phase.

Envelope and inclusive ge/le semantics follow test/fake-signins.ts in the pinned
MIT source. Tokens preserve the filtered snapshot across pages. No live fallback,
authentication, users or IP addresses are involved.
"""

from __future__ import annotations

import base64
import json
import re
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.parse import parse_qs, urlencode, urlsplit

DAY = "2026-07-04"


def event(identifier, minute, app, status):
    row = {"id": identifier, "createdDateTime": f"{DAY}T10:{minute:02d}:00Z", "appDisplayName": app}
    if status is not None:
        row["status"] = {"errorCode": status}
    return row


INITIAL = [
    event("s04", 15, "Portal", 0),
    event("s01", 0, "Portal", 0),
    event("s07", 30, "Batch", None),
    event("s03", 10, "Batch", 50126),
    event("s06", 25, "Portal", 0),
    event("s02", 5, "Portal", 0),
    event("s05", 20, "Batch", 0),
]
LATER = [
    event("s08", 23, "Portal", 50126),
    event("s09", 27, "Batch", 50126),
    event("s10", 35, "Portal", 0),
    event("s11", 40, "Batch", 0),
]


class SyntheticSigninsApi:
    def __init__(self):
        self.phase = 1
        self.requests = []
        self.server = None
        self.thread = None

    def publish_late_events(self):
        self.phase = 2

    def start(self):
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                try:
                    parsed = urlsplit(self.path)
                    if parsed.path != "/v1.0/auditLogs/signIns":
                        raise ValueError("Only synthetic sign-in metadata is available")
                    query = parse_qs(parsed.query)
                    if "$skiptoken" in query:
                        if set(query) != {"$skiptoken"}:
                            raise ValueError("Opaque page tokens must be followed verbatim")
                        encoded = query["$skiptoken"][0]
                        state = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
                    else:
                        if set(query) != {"$filter", "$top"}:
                            raise ValueError("Only inclusive time filters and page size are supported")
                        match = re.fullmatch(
                            r"createdDateTime ge (\S+) and createdDateTime le (\S+)", query["$filter"][0]
                        )
                        if match is None:
                            raise ValueError("Use the notebook's bounded ge/le replay window")
                        lo, hi = [datetime.fromisoformat(s) for s in match.groups()]
                        if (
                            lo.tzinfo is None
                            or hi.tzinfo is None
                            or not (
                                datetime(2026, 7, 4, 10, tzinfo=UTC)
                                <= lo
                                <= hi
                                <= datetime(2026, 7, 4, 10, 45, tzinfo=UTC)
                            )
                        ):
                            raise ValueError("Use 4 July 2026, 10:00–10:45 UTC")
                        top = int(query["$top"][0])
                        if top < 1:
                            raise ValueError("Page size must be positive")
                        state = {
                            "lo": lo.isoformat(),
                            "hi": hi.isoformat(),
                            "top": min(top, 3),
                            "offset": 0,
                            "phase": fixture.phase,
                        }
                    lo, hi = datetime.fromisoformat(state["lo"]), datetime.fromisoformat(state["hi"])
                    rows = INITIAL + (LATER if state["phase"] == 2 else [])
                    matched = [r for r in rows if lo <= datetime.fromisoformat(r["createdDateTime"]) <= hi]
                    offset, top = state["offset"], state["top"]
                    page = matched[offset : offset + top]
                    payload = {"value": page}
                    if offset + top < len(matched):
                        token = (
                            base64.urlsafe_b64encode(json.dumps({**state, "offset": offset + top}).encode())
                            .decode()
                            .rstrip("=")
                        )
                        payload["@odata.nextLink"] = (
                            "https://graph.microsoft.com/v1.0/auditLogs/signIns?"
                            + urlencode({"$skiptoken": token})
                        )
                    fixture.requests.append({**state, "path": self.path, "returned_rows": len(page)})
                    status = 200
                except (ValueError, KeyError, TypeError) as exc:
                    payload, status = {"error": str(exc)}, 400
                encoded = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        return self

    def stop(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()
        if self.thread:
            self.thread.join(timeout=2)
