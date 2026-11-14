# Scrapling 边车镜像
#
# Vercel 的 Serverless 跑不了常驻 Chromium，所以线上把这一层单独部署到
# 支持 Docker 的平台（Render / Fly.io / Railway / 自己的 VPS 都行）。
# 构建：docker build -t dp-scraper ./scraper
# 运行：docker run -p 8765:8765 -e SCRAPER_TOKEN=换成你的随机串 -v dp-state:/data dp-scraper
FROM python:3.12-slim

# SCRAPER_HOST 必须是 0.0.0.0，否则端口映射进来连不上
ENV PYTHONUNBUFFERED=1 \
    SCRAPER_HOST=0.0.0.0 \
    SCRAPER_PORT=8765 \
    SCRAPER_STATE_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# Chromium 的系统依赖 + 中文字体（不装字体，页面里的中文会渲染成方块）
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl tzdata fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# 下载打过补丁的 Chromium（--with-deps 会补齐 apt 里缺的库）
RUN python -m patchright install --with-deps chromium && chmod -R 755 /ms-playwright

# 用非 root 跑：Chromium 以 root 启动会拒绝 sandbox
RUN useradd -m -u 10001 scraper \
    && mkdir -p /data \
    && chown -R scraper:scraper /data /app
USER scraper

COPY --chown=scraper:scraper service.py ./

EXPOSE 8765

# 容器没有桌面环境，扫码登录用不了，登录态靠 POST /cookies 推进来（见 DEPLOY.md）
CMD ["python", "service.py"]
