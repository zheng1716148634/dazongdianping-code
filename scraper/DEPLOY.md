# 把抓取引擎部署到线上（Vercel 只跑前端）

## 为什么线上显示「引擎离线」

`scraper/service.py` 是一个常驻进程，里面要跑一个真 Chromium。Vercel 的 Serverless
函数是「请求来了起、跑完就停」，既装不下几百 MB 的浏览器，也扛不住 10~30 秒的抓取，
所以 Vercel 上永远不会有这个边车。前端检测到 `/api/scrapling/health` 不通，就显示
「引擎离线」，并自动降级到「Cookie + `/api/dp/fetch`」这条老通道。

有三条路，按投入从小到大：

| 方案 | 能拿到什么 | 代价 |
| --- | --- | --- |
| A. 线上就用 Cookie 通道 | 图文笔记、静图 | 0，现在就能用，只是没有实况视频 |
| B. 边车部署到自己电脑 / 内网机器 | 全部功能（隐身抓取 + 实况图） | 需要一个公网地址，机器得开着 |
| C. 边车部署到 Docker 云主机 | 全部功能 | 一台 1C2G 以上的机器（浏览器吃内存） |

方案 B/C 对前端来说是同一件事：配一个 `SCRAPLING_URL`。

## 方案 A：什么都不做

线上页面本来就有兜底：点「填写 Cookie」贴一条点评 Cookie，抓取走
`/api/dp/fetch`（Node 原生 fetch + 你给的 Cookie）。缺点是拿不到实况视频，
并且遇到强反爬的页面可能直接 403。

## 方案 B/C：部署边车

### 1. 起容器

```bash
# 在项目根目录
docker build -t dp-scraper ./scraper

docker run -d --name dp-scraper \
  -p 8765:8765 \
  -e SCRAPER_TOKEN='换成足够长的随机串' \
  -v dp-scraper-state:/data \
  --memory=2g --shm-size=1g \
  dp-scraper
```

- `SCRAPER_TOKEN`：**公网部署必须设**，否则这台机器就是一个谁都能用的点评抓取代理。
- `-v dp-scraper-state:/data`：Cookie 存在卷里，容器重建不用重新登录。
- `--shm-size=1g`：Chromium 默认 `/dev/shm` 只有 64MB，抓大页面会崩。

没有 Docker 也能直接跑，Python 3.10+：

```bash
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r scraper/requirements.txt
python -m patchright install --with-deps chromium
SCRAPER_HOST=0.0.0.0 SCRAPER_TOKEN='xxx' python scraper/service.py
```

### 2. 准备一个公网地址

托管平台都行，给几个已验证可行的：

- **Render**：新建 Web Service → Docker → Root Directory 填 `scraper` → 环境变量加
  `SCRAPER_TOKEN`。免费档会休眠，冷启动 30 秒以上，抓取超时就把 `timeout` 调大。
- **Fly.io**：`fly launch --dockerfile scraper/Dockerfile`，`fly secrets set SCRAPER_TOKEN=xxx`，
  然后 `fly deploy`。建议 `fly scale memory 2048`。
- **自己的 VPS**：`docker run` 起来后用 Caddy/Nginx 反代到 443，记得加 HTTPS，
  Vercel 那边只能填 https 地址。

健康检查路径填 `/health`（这个接口免鉴权，方便平台探活）。

### 3. 配到 Vercel

项目 → Settings → Environment Variables：

| 变量 | 值 |
| --- | --- |
| `SCRAPLING_URL` | `https://你的边车域名`（结尾不要带 `/`） |
| `SCRAPLING_TOKEN` | 与边车的 `SCRAPER_TOKEN` 完全一致 |

改完要 **Redeploy** 一次，环境变量只在构建/部署时注入。

配好后再打开页面：状态胶囊应该变成「引擎在线」，卡片上会标「远程引擎」。

### 4. 让远程引擎登录（关键）

容器里没有桌面，**「扫码登录」按钮在远程引擎下不会出现**，换成「填写 Cookie」：

1. 在自己电脑的浏览器打开 `https://m.dianping.com` 并登录；
2. DevTools → Network → 任意请求 → 复制 `Cookie` 请求头整串；
3. 页面左侧点「填写 Cookie」贴进去。

之后每次抓取前，前端会把这条 Cookie 自动 `POST /cookies` 推给引擎，引擎用它去请求。
Cookie 大约一个月过期，过期后重新贴一次。

## 接口与环境变量

链路是：浏览器 → `/api/scrapling/*`（Vercel 函数 `api/scrapling/[...path].js`）→ 你的边车。
函数只做转发，会把 `SCRAPLING_TOKEN` 塞进 `X-Scraper-Token` 头。

`vercel.json` 里给这个函数配了 `maxDuration: 60`。Hobby 档默认只有 10 秒，抓一条
笔记（隐身浏览器通常 5~15 秒）会被平台掐断，所以别删这段配置；免费档确实压到 10 秒的话，
把「快速 HTTP」模式当默认，或者升级档位。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SCRAPER_HOST` | `127.0.0.1` | 容器里设 `0.0.0.0` |
| `SCRAPER_PORT` | `8765` | |
| `SCRAPER_TOKEN` | 空 | 空 = 不鉴权，公网务必设置 |
| `SCRAPER_STATE_DIR` | `scraper/.state` | Cookie 与浏览器资料目录，容器里指到卷 |

鉴权方式：请求头 `X-Scraper-Token: <token>`（`/health` 免鉴权）。Vercel 的函数
`api/scrapling/[...path].js` 会自动带上这个头，你不必在前端处理。

## 排错

| 现象 | 原因 |
| --- | --- |
| 还是「引擎离线」，卡片提示「线上未接入抓取引擎」 | Vercel 没配 `SCRAPLING_URL`，或改了没 Redeploy |
| 提示「SCRAPLING_TOKEN 与服务端 SCRAPER_TOKEN 不一致」 | 两边字符串不同，注意有没多空格/引号 |
| 提示「抓取引擎响应超时」 | 免费档冷启动；先 `curl https://你的域名/health` 唤醒再试 |
| 引擎在线但每个任务都「要求登录」 | 没推 Cookie，或 Cookie 过期；重新贴一次 |
| 容器里 `browser: false` | 镜像构建时 `patchright install` 失败，看构建日志 |
| 抓取时容器 OOM | 内存给到 2G 以上，加 `--shm-size=1g` |
| 接口返回的是一坨 HTML | `api/scrapling/*` 被 rewrite 抢走了，确认 `api/scrapling/[...path].js` 已提交且部署成功（`curl -i 域名/api/scrapling/health` 应返回 JSON） |
| 实况视频播一半断 | Vercel 函数有响应体积上限（Hobby 4.5MB），长视频建议直接从边车域名取，别走函数 |
