#!/usr/bin/env python3
"""Local ToadAid Lore Land Vault server.

Serves index.html and a tightly bounded /api/artwork/<tokenId> proxy/cache.
Ownership is never determined here; the browser reader continues to prove
ownership from Base. This helper is display-media only.
"""
from __future__ import annotations

import hashlib
import html
import json
import mimetypes
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
ENV_PATH = ROOT / ".env"
_ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def load_local_env(path: Path) -> bool:
    """Load a small local .env file without adding a third-party dependency.

    Existing process environment variables always win over values in .env.
    Supported lines are KEY=VALUE or export KEY=VALUE; blank lines and #
    comments are ignored. Matching single or double quotes around a value are
    removed. The file is local-only and is ignored by Git.
    """
    if not path.is_file():
        return False
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not _ENV_KEY_RE.fullmatch(key):
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ.setdefault(key, value)
    return True


DOTENV_LOADED = load_local_env(ENV_PATH)
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "7777"))
CHAIN = "base"
CHAIN_ID = 8453
CONTRACT = "0x0495601af6f86efb14c9d478ea46b2aa09cb164a"
OPENSEA_KEY = os.environ.get("OPENSEA_API_KEY", "").strip()
OPEN_BROWSER = os.environ.get("OPEN_BROWSER", "").strip().lower() in {"1", "true", "yes", "on"}
CACHE_ROOT = ROOT / ".lore-vault-cache"
ART_DIR = CACHE_ROOT / "artwork"
META_DIR = CACHE_ROOT / "artwork-meta"
OVERRIDES_PATH = ROOT / "artwork-overrides.json"
MAX_IMAGE_BYTES = 25 * 1024 * 1024
MAX_HTML_BYTES = 8 * 1024 * 1024
TIMEOUT = 25
USER_AGENT = "Mozilla/5.0 TobyworldLoreLandDeedViewer/1.0 (ToadAid community tool)"

TRUSTED_MEDIA_SUFFIXES = (
    ".seadn.io",
    ".opensea.io",
    ".openseauserdata.com",
)


def host_allowed(url: str, *, page: bool = False) -> bool:
    try:
        u = urlparse(url)
    except Exception:
        return False
    if u.scheme != "https" or not u.hostname:
        return False
    h = u.hostname.lower()
    if page:
        return h == "opensea.io" or h == "api.opensea.io"
    return h in {"seadn.io", "opensea.io", "api.opensea.io"} or any(h.endswith(s) for s in TRUSTED_MEDIA_SUFFIXES)


def read_limited(resp, limit: int) -> bytes:
    chunks = []
    total = 0
    while True:
        chunk = resp.read(min(64 * 1024, limit + 1 - total))
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise ValueError(f"response exceeds {limit} bytes")
        chunks.append(chunk)
    return b"".join(chunks)


def http_get(url: str, *, accept: str, limit: int, api_key: str = "") -> tuple[bytes, str, str]:
    headers = {"User-Agent": USER_AGENT, "Accept": accept, "Accept-Encoding": "identity"}
    if api_key:
        headers["X-API-KEY"] = api_key
    req = Request(url, headers=headers, method="GET")
    with urlopen(req, timeout=TIMEOUT) as resp:
        final = resp.geturl()
        body = read_limited(resp, limit)
        ctype = (resp.headers.get_content_type() or "").lower()
        return body, ctype, final


def load_overrides() -> dict[str, str]:
    try:
        obj = json.loads(OVERRIDES_PATH.read_text(encoding="utf-8"))
        if int(obj.get("chainId", 0)) != CHAIN_ID or str(obj.get("contract", "")).lower() != CONTRACT:
            return {}
        items = obj.get("items") or {}
        out = {}
        for k, v in items.items():
            if str(k).isdigit() and isinstance(v, str) and host_allowed(v):
                out[str(int(k))] = v
        return out
    except Exception:
        return {}


def json_image_candidates(obj: dict) -> list[str]:
    root = obj.get("nft") if isinstance(obj.get("nft"), dict) else obj
    out: list[str] = []
    for key in ("display_image_url", "image_url", "image_original_url", "original_image_url", "cached_image_url", "media_url"):
        v = root.get(key) if isinstance(root, dict) else None
        if isinstance(v, str):
            out.append(v)
    md = root.get("metadata") if isinstance(root, dict) and isinstance(root.get("metadata"), dict) else {}
    for key in ("image", "image_url", "imageUrl", "media_url", "mediaUrl"):
        v = md.get(key)
        if isinstance(v, str):
            out.append(v)
    return dedupe_media(out)


def decode_html_url(s: str) -> str:
    s = html.unescape(s)
    s = s.replace("\\/", "/")
    try:
        s = bytes(s, "utf-8").decode("unicode_escape") if "\\u" in s else s
    except Exception:
        pass
    return s


def dedupe_media(values: Iterable[str]) -> list[str]:
    out = []
    seen = set()
    for value in values:
        if not isinstance(value, str):
            continue
        v = decode_html_url(value.strip())
        if not host_allowed(v):
            continue
        if v not in seen:
            seen.add(v)
            out.append(v)
    return out


def page_image_candidates(page: str) -> list[str]:
    vals: list[str] = []
    # Prefer OpenGraph/Twitter media if present.
    for pat in (
        r'<meta[^>]+property=["\']og:image(?::secure_url)?["\'][^>]+content=["\']([^"\']+)',
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image(?::secure_url)?["\']',
        r'<meta[^>]+name=["\']twitter:image["\'][^>]+content=["\']([^"\']+)',
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']twitter:image["\']',
    ):
        vals.extend(re.findall(pat, page, flags=re.I))
    # SeaDN URLs embedded in serialized page data. Prefer URLs containing the contract.
    raw = re.findall(r'https?(?::|\\u003A)(?:\\/|/){2}[^"\'<>\\s]+?seadn\\?\.io[^"\'<>\\s]*', page, flags=re.I)
    raw += re.findall(r'https?://[^"\'<>\s]+seadn\.io[^"\'<>\s]*', page, flags=re.I)
    raw = [decode_html_url(x.replace("\\u003A", ":")) for x in raw]
    exact = [x for x in raw if CONTRACT in x.lower()]
    vals.extend(exact)
    vals.extend(raw)
    return dedupe_media(vals)


def resolve_source(token_id: int) -> tuple[str, str]:
    tid = str(token_id)
    overrides = load_overrides()
    if tid in overrides:
        return overrides[tid], "override"

    errors = []
    if OPENSEA_KEY:
        api = f"https://api.opensea.io/api/v2/chain/{CHAIN}/contract/{CONTRACT}/nfts/{tid}"
        try:
            body, ctype, final = http_get(api, accept="application/json", limit=4 * 1024 * 1024, api_key=OPENSEA_KEY)
            if not host_allowed(final, page=True):
                raise ValueError("OpenSea API redirected to an untrusted host")
            obj = json.loads(body.decode("utf-8"))
            candidates = json_image_candidates(obj)
            if candidates:
                return candidates[0], "OpenSea API"
            errors.append("OpenSea API returned no SeaDN/media URL")
        except Exception as exc:
            errors.append(f"OpenSea API: {exc}")

    page_url = f"https://opensea.io/item/{CHAIN}/{CONTRACT}/{tid}"
    try:
        body, _ctype, final = http_get(page_url, accept="text/html,application/xhtml+xml", limit=MAX_HTML_BYTES)
        if not host_allowed(final, page=True):
            raise ValueError("OpenSea page redirected to an untrusted host")
        text = body.decode("utf-8", errors="replace")
        candidates = page_image_candidates(text)
        if candidates:
            return candidates[0], "OpenSea public item page"
        errors.append("OpenSea item page exposed no SeaDN artwork URL")
    except Exception as exc:
        errors.append(f"OpenSea page: {exc}")

    raise RuntimeError("; ".join(errors) or "no artwork source found")


def ext_for(content_type: str, url: str, body: bytes) -> str:
    c = content_type.split(";", 1)[0].lower()
    known = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif"}
    if c in known:
        return known[c]
    path_ext = Path(urlparse(url).path).suffix.lower()
    if path_ext in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"}:
        return ".jpg" if path_ext == ".jpeg" else path_ext
    if body.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if body.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if body[:4] == b"RIFF" and body[8:12] == b"WEBP":
        return ".webp"
    raise ValueError(f"unsupported artwork content type: {content_type or 'unknown'}")


def cached_artwork(token_id: int) -> tuple[Path, dict] | None:
    META_DIR.mkdir(parents=True, exist_ok=True)
    ART_DIR.mkdir(parents=True, exist_ok=True)
    meta_path = META_DIR / f"{token_id}.json"
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        name = meta.get("filename")
        p = ART_DIR / name
        if p.is_file() and p.stat().st_size > 0:
            return p, meta
    except Exception:
        pass
    return None


def fetch_and_cache(token_id: int) -> tuple[Path, dict]:
    hit = cached_artwork(token_id)
    if hit:
        return hit
    source_url, source_kind = resolve_source(token_id)
    if not host_allowed(source_url):
        raise RuntimeError("resolved media URL is outside the allowed SeaDN/OpenSea hosts")
    body, ctype, final = http_get(source_url, accept="image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8", limit=MAX_IMAGE_BYTES)
    if not host_allowed(final):
        raise RuntimeError("artwork download redirected outside the allowed media hosts")
    if not (ctype.startswith("image/") or body.startswith((b"\x89PNG", b"\xff\xd8\xff", b"RIFF"))):
        raise RuntimeError(f"artwork host returned non-image content ({ctype or 'unknown'})")
    ext = ext_for(ctype, final, body)
    digest = hashlib.sha256(body).hexdigest()
    filename = f"{token_id}-{digest[:16]}{ext}"
    ART_DIR.mkdir(parents=True, exist_ok=True)
    META_DIR.mkdir(parents=True, exist_ok=True)
    target = ART_DIR / filename
    fd, tmp_name = tempfile.mkstemp(prefix=f".{token_id}-", dir=str(ART_DIR))
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(body)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_name, target)
    finally:
        try:
            if os.path.exists(tmp_name):
                os.unlink(tmp_name)
        except OSError:
            pass
    meta = {
        "tokenId": token_id,
        "filename": filename,
        "contentType": ctype if ctype.startswith("image/") else mimetypes.guess_type(filename)[0] or "application/octet-stream",
        "bytes": len(body),
        "sha256": digest,
        "source": source_kind,
        "sourceUrl": final,
        "cachedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    (META_DIR / f"{token_id}.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return target, meta


def cache_count() -> int:
    if not META_DIR.is_dir():
        return 0
    return sum(1 for p in META_DIR.glob("*.json") if p.is_file())


class VaultHandler(SimpleHTTPRequestHandler):
    server_version = "TobyworldLoreLandDeedViewer/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        sys.stdout.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))
        sys.stdout.flush()

    def json_response(self, status: int, obj: dict):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/health":
            self.json_response(200, {
                "ok": True,
                "chainId": CHAIN_ID,
                "contract": CONTRACT,
                "cached_artworks": cache_count(),
                "override_count": len(load_overrides()),
                "opensea_api_key": bool(OPENSEA_KEY),
            })
            return
        m = re.fullmatch(r"/api/artwork/(\d+)", path)
        if m:
            try:
                token_id = int(m.group(1))
                if token_id < 0 or token_id > 2**53 - 1:
                    raise ValueError("token ID out of range")
                file_path, meta = fetch_and_cache(token_id)
                data_len = file_path.stat().st_size
                self.send_response(200)
                self.send_header("Content-Type", meta.get("contentType") or mimetypes.guess_type(file_path.name)[0] or "application/octet-stream")
                self.send_header("Content-Length", str(data_len))
                self.send_header("Cache-Control", "public, max-age=86400, immutable")
                self.send_header("X-ToadAid-Artwork-Source", str(meta.get("source", "cache")))
                self.end_headers()
                with file_path.open("rb") as f:
                    shutil.copyfileobj(f, self.wfile)
                return
            except (HTTPError, URLError, TimeoutError, ValueError, RuntimeError, OSError) as exc:
                self.json_response(502, {"ok": False, "tokenId": int(m.group(1)), "error": str(exc)})
                return
        super().do_GET()

    def do_DELETE(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/artwork-cache":
            try:
                if CACHE_ROOT.exists():
                    shutil.rmtree(CACHE_ROOT)
                self.json_response(200, {"ok": True, "cached_artworks": 0})
            except OSError as exc:
                self.json_response(500, {"ok": False, "error": str(exc)})
            return
        self.json_response(404, {"ok": False, "error": "not found"})


def main() -> int:
    if HOST not in {"127.0.0.1", "localhost", "::1"}:
        print("REFUSED: HOST must remain loopback-only (127.0.0.1, localhost, or ::1).", file=sys.stderr)
        return 2
    ART_DIR.mkdir(parents=True, exist_ok=True)
    META_DIR.mkdir(parents=True, exist_ok=True)
    httpd = ThreadingHTTPServer((HOST, PORT), VaultHandler)
    url = f"http://{HOST}:{PORT}/"
    print(f"Tobyworld Lore Land Deed Viewer: {url}")
    print(f"Artwork cache: {CACHE_ROOT}")
    print(f"Local .env: {'loaded' if DOTENV_LOADED else 'not found'}")
    print(f"OpenSea API key: {'available' if OPENSEA_KEY else 'not set; public item-page resolver will be tried'}")
    print("Press Ctrl+C to stop.")
    if OPEN_BROWSER:
        threading.Timer(0.35, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
