# -*- coding: utf-8 -*-
"""Scrapling 素材抓取边车服务。

职责（只做这三件事，业务编排留在前端）：
  1. /fetch   用 Scrapling 的隐身浏览器 / 快速 HTTP 抓点评笔记页，返回 HTML + 实况图配对；
  2. /login   弹一个有头浏览器窗口，让用户扫码登录，把 Cookie 落到本地文件长期复用；
  3. /media   代理下载 CDN 上的图片和实况视频，带 Referer、支持 Range 分段。

设计取舍：
  * 登录态两条腿走路：浏览器用持久化的 user_data_dir（窗口里登录后，无头抓取直接继承），
    同时把 Cookie 另存一份 JSON —— 可读、可清、可排错，也方便快速 HTTP 通道复用。
  * Scrapling 的 fetch/get 都用 **kwargs 收 TypedDict，参数名从注解里读出来做过滤，
    不同版本增删参数不会把服务跑挂。
  * 浏览器内核缺失时自动降级到 HTTP 通道，并把「怎么装」原样带回去，不让前端只看到
    一串 Playwright 报错。
"""

import hmac
import json
import os
import re
import threading
import time
import urllib.parse
from pathlib import Path

from flask import Flask, Response, jsonify, request, stream_with_context

BASE_DIR = Path(__file__).resolve().parent
# 登录态（Cookie + 浏览器资料目录）默认落在 scraper/.state。
# 注意：这个目录里有被 Chromium 独占锁定的文件，必须保证它不被任何文件监听器扫到
# （vite.config.js 已把整棵 scraper/ 排除），否则 Windows 上会 EBUSY 崩掉 dev server。
# 想挪到项目外可以用环境变量 SCRAPER_STATE_DIR 指过去。
STATE_DIR = Path(os.environ.get("SCRAPER_STATE_DIR") or (BASE_DIR / ".state"))
STATE_DIR.mkdir(parents=True, exist_ok=True)
COOKIE_FILE = STATE_DIR / "cookies.json"
PROFILE_DIR = STATE_DIR / "profile"

HOST_RE = re.compile(r"(^|\.)(dianping\.com|meituan\.net|dpfile\.com|dpurl\.cn)$", re.I)
MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
)

app = Flask(__name__)
app.config["JSON_AS_ASCII"] = False

# 部署到公网（Docker / VPS / Render）时必须设 SCRAPER_TOKEN，否则这台机器就成了
# 谁都能用的点评抓取代理。本地开发不设就走免鉴权。
TOKEN = (os.environ.get("SCRAPER_TOKEN") or "").strip()

LOGIN = {"running": False, "waiting": False, "since": 0.0, "error": ""}
_LOGIN_LOCK = threading.Lock()


def authorized() -> bool:
    if not TOKEN:
        return True
    got = request.headers.get("X-Scraper-Token") or request.args.get("token") or ""
    return hmac.compare_digest(got, TOKEN)


@app.before_request
def _guard():
    # /health 免鉴权，方便探活；但它只返回最小信息，免得把路径、昵称漏出去
    if authorized() or request.path == "/health":
        return None
    return jsonify({"error": "UNAUTHORIZED", "message": "缺少或错误的 X-Scraper-Token"}), 401



# ---------------------------------------------------------------- 通用小工具


def scrapling_version():
    try:
        import scrapling

        return getattr(scrapling, "__version__", "") or "0.5.x"
    except Exception:
        return ""


def browser_ready():
    """浏览器内核是否已经下载好。

    三个可能的位置都查一遍：容器里是 PLAYWRIGHT_BROWSERS_PATH，Windows 是 LOCALAPPDATA，
    Linux 裸机是 ~/.cache。只看 .exe 会在 Docker 里误报「未安装」。
    """
    roots = []
    if os.environ.get("PLAYWRIGHT_BROWSERS_PATH"):
        roots.append(Path(os.environ["PLAYWRIGHT_BROWSERS_PATH"]))
    if os.environ.get("LOCALAPPDATA"):
        roots.append(Path(os.environ["LOCALAPPDATA"]) / "ms-playwright")
    roots.append(Path.home() / ".cache" / "ms-playwright")

    for root in roots:
        try:
            for exe in root.glob("chromium*/*/chrome*"):
                if exe.is_file():
                    return True
        except Exception:
            continue
    # 允许直接用系统已装的 Chrome（StealthyFetcher 的 real_chrome 选项）
    for candidate in (
        Path(os.environ.get("PROGRAMFILES", "C:/Program Files")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("PROGRAMFILES(X86)", "C:/Program Files (x86)")) / "Google/Chrome/Application/chrome.exe",
        Path("/usr/bin/google-chrome"),
        Path("/usr/bin/chromium"),
    ):
        if candidate.exists():
            return True
    return False


def _param_keys(name):
    """Scrapling 的 fetch/get 都用 **kwargs 收 TypedDict，直接查注解拿到合法参数名。"""
    try:
        from scrapling.engines._browsers import _types

        table = {
            "stealth": getattr(_types, "StealthSession", None),
            "http": getattr(_types, "GetRequestParams", None),
        }
        target = table.get(name)
        return set(getattr(target, "__annotations__", {}) or {})
    except Exception:
        return set()


def _filter(kwargs, name):
    keys = _param_keys(name)
    return {k: v for k, v in kwargs.items() if k in keys} if keys else kwargs


def load_cookies():
    if not COOKIE_FILE.exists():
        return {}
    try:
        data = json.loads(COOKIE_FILE.read_text("utf-8"))
    except Exception:
        return {}
    return data.get("cookies") or {}


def login_state():
    data = {}
    if COOKIE_FILE.exists():
        try:
            data = json.loads(COOKIE_FILE.read_text("utf-8"))
        except Exception:
            data = {}
    cookies = data.get("cookies") or {}
    # 点评登录后必有 dper（以及 dper2），这是最稳的判据
    logged_in = any(name.startswith("dper") for name in cookies)
    return {
        "loggedIn": logged_in,
        "nickname": data.get("nickname") or "",
        "savedAt": data.get("savedAt") or 0,
        "waiting": LOGIN["waiting"],
        "error": LOGIN["error"],
    }


def is_allowed(url: str) -> bool:
    try:
        host = urllib.parse.urlparse(url).hostname or ""
    except Exception:
        return False
    return bool(HOST_RE.search(host))


# ---------------------------------------------------------------- 实况图提取

_IMAGE_RE = re.compile(r"(?:https?:)?//[^\s\"'<>()\\]+?\.(?:jpg|jpeg|png|webp)(?:\?[^\s\"'<>\\]*)?", re.I)
_VIDEO_RE = re.compile(r"(?:https?:)?//[^\s\"'<>()\\]+?\.(?:mp4|mov|m3u8)(?:\?[^\s\"'<>\\]*)?", re.I)
# 一个「媒体对象」：花括号内同时出现视频和图片。点评的 qwik/json 状态是扁平展开的，
# 同一条 media 的字段基本挨在一起，用这个粗糙但足够稳的方式配对。
_OBJECT_RE = re.compile(r"\{[^{}]{0,1200}?\}")
_DURATION_RE = re.compile(r'"duration"\s*:\s*(\d+)')


def decode_escapes(text: str) -> str:
    return (
        text.replace("\\u002F", "/")
        .replace("\\u002f", "/")
        .replace("\\u003A", ":")
        .replace("\\u003a", ":")
        .replace("\\/", "/")
        .replace("&amp;", "&")
    )


def _absolute(url: str) -> str:
    return url if url.startswith("http") else f"https:{url}"


def extract_live_pairs(html: str):
    """从页面里找出「静图 + 短视频」的实况图配对。

    返回 [{cover, video, duration}]；duration 单位秒（原始值多为毫秒）。
    """
    source = decode_escapes(html or "")
    pairs = []
    seen = set()

    for obj in _OBJECT_RE.findall(source):
        video_m = _VIDEO_RE.search(obj)
        if not video_m:
            continue
        video = _absolute(video_m.group(0))
        if video in seen:
            continue
        image_m = _IMAGE_RE.search(obj)
        cover = _absolute(image_m.group(0)) if image_m else ""
        if "avatar" in cover or "icon" in cover:
            cover = ""

        duration = 0.0
        duration_m = _DURATION_RE.search(obj)
        if duration_m:
            raw = float(duration_m.group(1))
            # 点评的时长字段有毫秒也有秒，>100 一律当毫秒
            duration = raw / 1000 if raw > 100 else raw

        seen.add(video)
        pairs.append({"cover": cover, "video": video, "duration": round(duration, 2)})

    # 兜底：配对失败但页面里确实有 mp4，也要让用户拿得到
    for match in _VIDEO_RE.finditer(source):
        video = _absolute(match.group(0))
        if video in seen:
            continue
        if "/ad" in video or "adcreative" in video:
            continue
        seen.add(video)
        pairs.append({"cover": "", "video": video, "duration": 0.0})

    return pairs


# 未登录时点评会把人踢到三种地方，都要认出来：M 站笔记专用跳转、PC 扫码登录页、账站登录域名
_LOGIN_URL_RE = re.compile(r"(feeddetail/login-redirect|pclogin|account\.dianping\.com/(?:login|pclogin))", re.I)
_LOGIN_TEXT_RE = re.compile(r"(扫码登录|请先登录|登录后查看|立即登录)")


def looks_like_login(url: str, html: str) -> bool:
    if _LOGIN_URL_RE.search(url or ""):
        return True
    # 页面正文里明确要求登录，且标题就是「大众点评网」这种登录壳页
    if _LOGIN_TEXT_RE.search(html or "") and "<title>大众点评网</title>" in (html or ""):
        return True
    return False


# ---------------------------------------------------------------- 抓取


def _html_of(page) -> str:
    for attr in ("html_content", "body", "text", "content"):
        value = getattr(page, attr, None)
        if isinstance(value, bytes):
            return value.decode("utf-8", "ignore")
        if isinstance(value, str) and value:
            return value
    return ""


def fetch_stealth(url: str, timeout: int = 60):
    from scrapling.fetchers import StealthyFetcher

    kwargs = {
        "headless": True,
        "network_idle": True,
        "timeout": timeout * 1000,
        # 复用登录时那个持久化浏览器资料目录，登录态直接继承，不用再手动塞 Cookie
        "user_data_dir": str(PROFILE_DIR),
        "locale": "zh-CN",
        "extra_headers": {"Accept-Language": "zh-CN,zh;q=0.9", "Referer": "https://m.dianping.com/"},
    }
    return StealthyFetcher.fetch(url, **_filter(kwargs, "stealth"))


def fetch_http(url: str, timeout: int = 30):
    from scrapling.fetchers import Fetcher

    kwargs = {
        "impersonate": "chrome",
        "stealthy_headers": True,
        "timeout": timeout,
        "headers": {"Accept-Language": "zh-CN,zh;q=0.9", "Referer": "https://m.dianping.com/"},
        "cookies": load_cookies(),
    }
    return Fetcher.get(url, **_filter(kwargs, "http"))


@app.post("/fetch")
def fetch():
    body = request.get_json(force=True, silent=True) or {}
    url = str(body.get("url") or "").strip()
    if not is_allowed(url):
        return jsonify({"error": "HOST_NOT_ALLOWED"}), 403

    mode = body.get("mode") or "stealth"
    with_live = bool(body.get("with_live", True))

    started = time.time()
    used_mode = mode
    try:
        page = fetch_stealth(url) if mode == "stealth" else fetch_http(url)
    except Exception as err:
        detail = f"{type(err).__name__}: {err}"
        if "Executable doesn't exist" in detail or "executable doesn't exist" in detail.lower():
            # 浏览器没装：退回快速 HTTP 通道，至少把能拿的拿到，并在响应里说清楚原因
            try:
                page = fetch_http(url)
                used_mode = "http-fallback"
            except Exception as err2:
                return (
                    jsonify(
                        {
                            "error": "BROWSER_MISSING",
                            "message": "隐身浏览器内核未安装：在项目根目录执行 npm run scraper:setup",
                            "detail": f"{type(err2).__name__}: {err2}",
                        }
                    ),
                    503,
                )
        else:
            return jsonify({"error": "FETCH_FAILED", "message": detail}), 502

    html = _html_of(page)
    final_url = str(getattr(page, "url", "") or url)
    status = int(getattr(page, "status", 200) or 200)

    if not html:
        return jsonify({"error": "EMPTY_RESPONSE", "finalUrl": final_url}), 502

    login_required = looks_like_login(final_url, html) or (login_state()["loggedIn"] is False and status >= 400)

    return jsonify(
        {
            "html": html,
            "finalUrl": final_url,
            "status": status,
            "mode": used_mode,
            "elapsed": round(time.time() - started, 2),
            "loginRequired": login_required,
            "live": extract_live_pairs(html) if with_live else [],
        }
    )


# ---------------------------------------------------------------- 登录


def _login_worker(lifetime: float = 180.0):
    """开一个有头浏览器窗口让用户扫码，登录成功后把 Cookie 落盘。

    这里同样用 Scrapling 的 StealthySession（底层是打过补丁的 Chromium），
    并指定 user_data_dir —— 窗口里登录产生的状态会留在该目录，后续无头抓取直接继承。
    """
    LOGIN.update({"running": True, "waiting": True, "since": time.time(), "error": ""})
    try:
        from scrapling.fetchers import StealthySession

        kwargs = _filter(
            {
                "headless": False,
                "user_data_dir": str(PROFILE_DIR),
                "locale": "zh-CN",
                "timeout": 45000,
                "network_idle": False,
            },
            "stealth",
        )
        with StealthySession(**kwargs) as session:
            try:
                session.fetch("https://m.dianping.com/", **_filter({"timeout": 45000}, "stealth"))
            except Exception:
                # 首页打不开不影响用户自己点登录，继续轮询
                pass

            deadline = time.time() + lifetime
            while time.time() < deadline:
                try:
                    cookies = {
                        c["name"]: c["value"]
                        for c in session.context.cookies()
                        if "dianping" in (c.get("domain") or "")
                    }
                except Exception as err:
                    LOGIN["error"] = f"浏览器已关闭：{err}"
                    return
                if any(name.startswith("dper") for name in cookies):
                    COOKIE_FILE.write_text(
                        json.dumps(
                            {"cookies": cookies, "nickname": "", "savedAt": int(time.time() * 1000)},
                            ensure_ascii=False,
                            indent=2,
                        ),
                        "utf-8",
                    )
                    LOGIN["error"] = ""
                    return
                time.sleep(1.5)
            LOGIN["error"] = "等待登录超时"
    except Exception as err:
        LOGIN["error"] = f"{type(err).__name__}: {err}"
    finally:
        LOGIN.update({"running": False, "waiting": False})


@app.post("/login")
def login():
    with _LOGIN_LOCK:
        if LOGIN["running"]:
            return jsonify({"started": True, "waiting": True})
        threading.Thread(target=_login_worker, daemon=True).start()
    return jsonify({"started": True, "waiting": True})


@app.get("/login/status")
def login_status():
    return jsonify(login_state())


@app.post("/logout")
def logout():
    try:
        COOKIE_FILE.unlink(missing_ok=True)
    except Exception:
        pass
    return jsonify({"ok": True, "loggedIn": False})


@app.post("/cookies")
def set_cookies():
    """直接把一条 Cookie 字符串写进登录态。

    给线上部署用：服务器上没有桌面环境，弹不出扫码窗口，只能让用户在自己电脑上
    登录好，复制 Cookie 通过这个接口推进来。接受两种格式：
        {"cookie": "a=1; b=2"}      浏览器 DevTools 里复制的那种
        {"cookies": {"a": "1"}}     JSON 形式
    """
    body = request.get_json(force=True, silent=True) or {}
    raw = body.get("cookie") or body.get("cookies") or ""
    if isinstance(raw, dict):
        cookies = {str(k): str(v) for k, v in raw.items()}
    else:
        cookies = {}
        for part in str(raw).split(";"):
            if "=" not in part:
                continue
            key, value = part.split("=", 1)
            key = key.strip()
            if key:
                cookies[key] = value.strip()
    if not cookies:
        return jsonify({"error": "EMPTY_COOKIE", "message": "没解析出任何键值对，确认是 a=1; b=2 这种格式"}), 400

    COOKIE_FILE.parent.mkdir(parents=True, exist_ok=True)
    COOKIE_FILE.write_text(
        json.dumps(
            {"cookies": cookies, "nickname": "", "savedAt": int(time.time() * 1000), "source": "manual"},
            ensure_ascii=False,
            indent=2,
        ),
        "utf-8",
    )
    return jsonify({"ok": True, "count": len(cookies), **login_state()})



# ---------------------------------------------------------------- 媒体代理


@app.get("/media")
def media():
    target = request.args.get("url") or ""
    if not is_allowed(target):
        return jsonify({"error": "HOST_NOT_ALLOWED"}), 403

    headers = {
        "User-Agent": MOBILE_UA,
        "Referer": "https://m.dianping.com/",
        "Accept": "image/avif,image/webp,image/apng,video/*,*/*;q=0.8",
    }
    # 浏览器拖动视频进度条时会带 Range，必须原样转发，否则只能从头播
    if request.headers.get("Range"):
        headers["Range"] = request.headers["Range"]

    try:
        from curl_cffi import requests as cffi_requests

        upstream = cffi_requests.get(target, headers=headers, impersonate="chrome", stream=True, timeout=60)
    except Exception:
        upstream = None

    if upstream is None:
        import urllib.request

        req = urllib.request.Request(target, headers=headers)
        try:
            raw = urllib.request.urlopen(req, timeout=60)
        except Exception as err:
            return jsonify({"error": "MEDIA_FETCH_FAILED", "message": str(err)}), 502

        def gen():
            try:
                while True:
                    chunk = raw.read(64 * 1024)
                    if not chunk:
                        break
                    yield chunk
            finally:
                raw.close()

        passthrough = {}
        for key in ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"):
            if raw.headers.get(key):
                passthrough[key] = raw.headers[key]
        return Response(stream_with_context(gen()), status=raw.status, headers=passthrough)

    if upstream.status_code >= 400:
        return jsonify({"error": "MEDIA_FETCH_FAILED", "status": upstream.status_code}), 502

    passthrough = {"Cache-Control": "public, max-age=86400"}
    for key in ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"):
        value = upstream.headers.get(key)
        if value:
            passthrough[key] = value

    def generate():
        try:
            for chunk in upstream.iter_content(64 * 1024):
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    return Response(stream_with_context(generate()), status=upstream.status_code, headers=passthrough)


# ---------------------------------------------------------------- 启动


@app.get("/health")
def health():
    state = login_state()
    payload = {
        "ok": True,
        "scrapling": scrapling_version(),
        "browser": browser_ready(),
        "login": state,
        # 带 token 部署时 /health 免鉴权，就别把服务端路径暴露出去
        "authRequired": bool(TOKEN),
    }
    if not TOKEN or authorized():
        payload["cookieFile"] = str(COOKIE_FILE)
    return jsonify(payload)


if __name__ == "__main__":
    # 容器里必须监听 0.0.0.0，否则端口映射进来连不上
    host = os.environ.get("SCRAPER_HOST", "127.0.0.1")
    port = int(os.environ.get("SCRAPER_PORT", "8765"))
    print(
        f"[scrapling] service on http://{host}:{port}  "
        f"(scrapling={scrapling_version() or '未安装'}, auth={'on' if TOKEN else 'off'})",
        flush=True,
    )
    app.run(host=host, port=port, threaded=True)
