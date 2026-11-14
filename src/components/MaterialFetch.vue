<script setup>
// 素材获取（Scrapling 版）
// 与「AI提取素材」的区别：
// 1. 不再依赖手动粘贴 Cookie —— 引擎用带持久化用户目录的隐身浏览器，扫码登录一次后一直复用；
// 2. 能抓到实况图（静图 + 配套 2~3 秒短视频），悬停即播，可单独下载视频；
// 3. 支持一次贴多条链接批量跑，任务逐条显示状态；
// 4. 引擎没启动时自动降级回旧的 Cookie + /api/dp/fetch 通道，页面不会直接废掉。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Connection,
  Download,
  Link,
  Picture,
  Refresh,
  Setting,
  User,
  VideoCamera,
  VideoPlay,
} from '@element-plus/icons-vue'
import {
  fetchNote,
  getHealth,
  logout as logoutEngine,
  mediaUrl,
  pollLogin,
  startBrowserLogin,
} from '../utils/scrapling'
import { extractFeedId, isDianpingUrl, isDpShortUrl, normalizeNoteUrl, parseFeedHtml } from '../utils/dianping'
import ImageZoomPreview from './ImageZoomPreview.vue'
import { cachedNotes, clearAllNotes, initMaterials, removeImageFromNote, upsertNote } from '../stores/materials'

const COOKIE_KEY = 'dianping-cookie'

// 只要大图：短边低于该值的图文素材丢掉（头像、图标、二维码），实况图不受此限制
const MIN_SIDE = 800

const rawText = ref('')
const textareaRef = ref(null)
const mode = ref('stealth')
const withLive = ref(true)
const onlyBig = ref(true)

// ---------- 引擎状态 ----------

const health = ref({ online: false, checking: true, version: '', browser: false, message: '' })
const login = ref({ loggedIn: false, nickname: '', savedAt: 0 })

async function refreshHealth() {
  health.value = { ...health.value, checking: true }
  try {
    const data = await getHealth()
    health.value = {
      online: true,
      checking: false,
      version: data.scrapling || '',
      browser: Boolean(data.browser),
      message: '',
    }
    login.value = data.login || { loggedIn: false }
  } catch (err) {
    health.value = { online: false, checking: false, version: '', browser: false, message: String(err.message || err) }
  }
}

// 弹窗扫码：服务端开一个有头浏览器，用户在窗口里登录，这里轮询到登录成功为止
const loginBusy = ref(false)

async function startLogin() {
  if (loginBusy.value) return
  loginBusy.value = true
  try {
    await startBrowserLogin()
    ElMessage.info('已打开浏览器窗口，请用手机扫码登录，完成后会自动同步')
    const deadline = Date.now() + 180000
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1600))
      const status = await pollLogin()
      if (status.loggedIn) {
        login.value = status
        ElMessage.success(`登录成功${status.nickname ? `：${status.nickname}` : ''}，之后抓取都不用再扫码`)
        return
      }
      if (!status.waiting) throw new Error('登录窗口已关闭，未检测到登录态')
    }
    throw new Error('等待登录超时，请重试')
  } catch (err) {
    ElMessage.error(String(err.message || err))
  } finally {
    loginBusy.value = false
  }
}

async function doLogout() {
  try {
    await ElMessageBox.confirm('将清除引擎里保存的点评登录态，下次抓取需要重新扫码。确定继续吗？', '退出登录', {
      confirmButtonText: '退出登录',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  await logoutEngine()
  login.value = { loggedIn: false }
  ElMessage.success('已退出登录')
}

// ---------- 手工 Cookie（引擎离线时的兜底） ----------

const cookie = ref('')
const cookieDialogVisible = ref(false)
const cookieInput = ref('')

function openCookieDialog() {
  cookieInput.value = cookie.value
  cookieDialogVisible.value = true
}

function saveCookie() {
  const value = cookieInput.value.trim()
  cookie.value = value
  if (value) localStorage.setItem(COOKIE_KEY, value)
  else localStorage.removeItem(COOKIE_KEY)
  cookieDialogVisible.value = false
  ElMessage[value ? 'success' : 'info'](value ? 'Cookie 已保存到本机' : '已清空 Cookie')
}

// ---------- 链接识别 ----------

const URL_RE = /https?:\/\/[^\s<>"'）)，,]+/gi

const detected = computed(() => {
  const seen = new Set()
  const list = []
  for (const match of rawText.value.matchAll(URL_RE)) {
    const url = match[0].replace(/[.,;]+$/, '')
    if (!isDianpingUrl(url)) continue
    if (seen.has(url)) continue
    seen.add(url)
    list.push(url)
  }
  return list
})

const engineOnline = computed(() => health.value.online)

// ---------- 任务队列 ----------

const jobs = ref([])
const running = ref(false)

function setJob(url, patch) {
  const index = jobs.value.findIndex((job) => job.url === url)
  if (index === -1) jobs.value = [...jobs.value, { url, state: 'pending', message: '', ...patch }]
  else jobs.value = jobs.value.map((job, i) => (i === index ? { ...job, ...patch } : job))
}

// 图片地址归一：CDN 常靠 query（imageMogr2 之类）区分规格，比对时只认路径
function mediaKey(url) {
  try {
    return new URL(url, 'https://m.dianping.com').pathname.toLowerCase()
  } catch {
    return String(url).toLowerCase()
  }
}

async function blobFrom(url, viaEngine) {
  const endpoint = viaEngine ? mediaUrl(url) : `/api/dp/image?url=${encodeURIComponent(url)}`
  const res = await fetch(endpoint)
  if (!res.ok) throw new Error(`素材下载失败 ${res.status}`)
  return res.blob()
}

async function pool(items, limit, worker) {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const slot = cursor++
      await worker(items[slot], slot)
    }
  })
  await Promise.all(runners)
}

async function measure(blob) {
  if (!blob) return null
  try {
    const bitmap = await createImageBitmap(blob)
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close?.()
    return size
  } catch {
    return null
  }
}

// 把解析结果 + 实况对 组装成可入库的 images（含 blob / live.videoBlob）
async function buildImages(parsed, liveList, viaEngine) {
  const stills = parsed.images || []
  const output = new Array(stills.length)
  const usedLive = new Set()

  await pool(
    stills.map((url, index) => ({ url, index })),
    5,
    async ({ url, index }) => {
      try {
        const blob = await blobFrom(url, viaEngine)
        const size = await measure(blob)
        output[index] = { url, blob, kind: 'image', width: size?.width, height: size?.height }
      } catch {
        // 单张失败不拖累整条笔记，保留远程地址兜底展示
        output[index] = { url, blob: null, kind: 'image' }
      }
    },
  )

  // 实况图：服务端给了 { cover, video } 的配对，按封面路径挂到对应静图上
  for (const live of liveList) {
    const cover = live.cover || ''
    let target = null
    if (cover) {
      const key = mediaKey(cover)
      target = output.find((img, i) => !usedLive.has(i) && mediaKey(img.url) === key)
      if (target) usedLive.add(output.indexOf(target))
    }
    if (!target) {
      // 找不到封面（纯视频，或封面图被过滤掉了）：单独排一项，前端按视频卡片展示
      target = { url: cover || live.video, blob: null, kind: 'video' }
      output.push(target)
      usedLive.add(output.length - 1)
    }
    target.kind = 'live'
    target.live = {
      videoUrl: live.video,
      duration: live.duration || 0,
      width: live.width || 0,
      height: live.height || 0,
      videoBlob: null,
    }
  }

  // 视频单独下载：体积比图大得多，并发降到 2，避免把带宽和内存打满
  const lives = output.filter((img) => img.live?.videoUrl)
  await pool(lives, 2, async (img) => {
    try {
      img.live.videoBlob = await blobFrom(img.live.videoUrl, viaEngine)
    } catch {
      img.live.videoBlob = null
    }
  })

  if (onlyBig.value) {
    return output.filter((img) => {
      if (img.kind === 'video') return true
      if (img.live) return true // 实况图分辨率常被压过，不能按大图规则筛
      const side = Math.min(img.width || 0, img.height || 0)
      return side ? side > MIN_SIDE : true
    })
  }
  return output
}

// ---------- 两条抓取通道 ----------

async function scrapeByEngine(url) {
  const data = await fetchNote(url, { mode: mode.value, withLive: withLive.value })
  if (data.loginRequired) {
    const error = new Error('点评要求登录：点左上「扫码登录」后再试')
    error.needLogin = true
    throw error
  }
  if (!data.html) throw new Error('引擎没有返回页面内容')
  const parsed = parseFeedHtml(data.html)
  if (parsed.loginRequired) {
    const error = new Error('页面被重定向到登录页，请重新扫码登录')
    error.needLogin = true
    throw error
  }
  const images = await buildImages(parsed, data.live || [], true)
  return { parsed, images, finalUrl: data.finalUrl || url, engine: data.mode || mode.value }
}

async function scrapeByCookie(url) {
  if (!cookie.value) {
    const error = new Error('引擎未启动时需要点评 Cookie，点「填写 Cookie」')
    error.needCookie = true
    throw error
  }
  const res = await fetch('/api/dp/fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: normalizeNoteUrl(url), cookie: cookie.value }),
  })
  const data = await res.json()
  if (data.error === 'LOGIN_REQUIRED') {
    const error = new Error('点评登录态失效，请更新 Cookie')
    error.needCookie = true
    throw error
  }
  if (data.error) throw new Error(data.message || data.error)
  const parsed = parseFeedHtml(data.html)
  if (parsed.loginRequired) {
    const error = new Error('页面被重定向到登录页，请更新 Cookie')
    error.needCookie = true
    throw error
  }
  // 兜底通道只走 Node 原生请求，拿不到实况视频，只有静图
  const images = await buildImages(parsed, [], false)
  return { parsed, images, finalUrl: data.finalUrl || url, engine: 'cookie' }
}

async function runOne(url) {
  setJob(url, { state: 'loading', message: '抓取中…' })
  const started = Date.now()
  try {
    const { parsed, images, finalUrl, engine } = engineOnline.value
      ? await scrapeByEngine(url)
      : await scrapeByCookie(url)

    if (!images.length && !parsed.content) {
      throw new Error('没解析到图文素材，笔记可能已删除或设为私密')
    }

    const resolvedUrl =
      finalUrl && isDianpingUrl(finalUrl) && !isDpShortUrl(finalUrl) ? finalUrl : url
    const id = extractFeedId(resolvedUrl) || extractFeedId(url) || resolvedUrl
    const liveCount = images.filter((img) => img.live?.videoBlob).length

    await upsertNote({
      id,
      url: resolvedUrl,
      title: parsed.title || `笔记 ${id}`,
      content: parsed.content,
      shop: parsed.shop,
      images,
      fetchedAt: Date.now(),
      source: engine === 'cookie' ? 'cookie' : 'scrapling',
    })

    const cost = ((Date.now() - started) / 1000).toFixed(1)
    setJob(url, {
      state: 'done',
      message: `${images.length} 项素材${liveCount ? ` · ${liveCount} 个实况` : ''} · ${cost}s`,
    })
    return { ok: true, liveCount }
  } catch (err) {
    setJob(url, { state: 'error', message: String(err.message || err) })
    if (err.needLogin) startLogin()
    else if (err.needCookie) openCookieDialog()
    return { ok: false }
  }
}

async function startFetch() {
  if (!detected.value.length || running.value) return
  running.value = true
  jobs.value = []
  let liveTotal = 0
  let okCount = 0
  try {
    for (const url of detected.value) {
      const result = await runOne(url)
      if (result.ok) {
        okCount++
        liveTotal += result.liveCount
      }
    }
    if (okCount) {
      const liveTip = liveTotal ? `，其中 ${liveTotal} 张实况图` : ''
      ElMessage.success(`已获取 ${okCount} 条笔记${liveTip}`)
    }
  } finally {
    running.value = false
  }
}

async function refetchNote(note) {
  await runOne(note.url)
}

// ---------- 素材展示 ----------

const previewIndex = ref(-1)
const previewNote = ref(null)

function openPreview(note, index) {
  previewNote.value = note
  previewIndex.value = index
}

// 转存失败（blob 为空）时的兜底显示：走本地代理带上 Referer 去取，
// 直接让 <img> 请求 CDN 会因为缺 Referer 被 403，显示成裂图
function displaySrc(note, img) {
  if (img.blob || img.src?.startsWith('blob:')) return img.src
  return note.source === 'scrapling' ? mediaUrl(img.url) : `/api/dp/image?url=${encodeURIComponent(img.url)}`
}

// 实况图单独预览：静图当封面，短视频循环播
const livePreview = ref(null) // { image, noteTitle }

function openLivePreview(note, img) {
  livePreview.value = { image: img, noteTitle: note.title }
}

function playHover(event) {
  const video = event.currentTarget.querySelector('video')
  if (!video) return
  video.currentTime = 0
  video.play().catch(() => {})
}

function stopHover(event) {
  const video = event.currentTarget.querySelector('video')
  if (!video) return
  video.pause()
  video.currentTime = 0
}

async function saveBlob(blob, filename) {
  if (!blob) {
    ElMessage.warning('这个文件没有下载成功，试试重新获取')
    return
  }
  const anchor = document.createElement('a')
  anchor.href = URL.createObjectURL(blob)
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(anchor.href), 4000)
}

function extOf(blob, fallback) {
  const type = (blob?.type || '').toLowerCase()
  if (type.includes('png')) return 'png'
  if (type.includes('webp')) return 'webp'
  if (type.includes('gif')) return 'gif'
  if (type.includes('quicktime')) return 'mov'
  if (type.includes('mp4')) return 'mp4'
  return fallback
}

async function downloadStill(note, img) {
  if (!img.blob) {
    ElMessage.warning('这张静图没抓到，重新获取试试')
    return
  }
  await saveBlob(img.blob, `点评素材-${note.id}-${Date.now()}.${extOf(img.blob, 'jpg')}`)
  ElMessage.success('静图已下载')
}

async function downloadVideo(note, img) {
  if (!img.live?.videoBlob) {
    ElMessage.warning('这条实况视频没抓到，重新获取试试')
    return
  }
  await saveBlob(img.live.videoBlob, `点评实况-${note.id}-${Date.now()}.${extOf(img.live.videoBlob, 'mp4')}`)
  ElMessage.success('实况视频已下载，可与同组静图一起在相册里合成为实况照片')
}

async function removeImage(note, img) {
  await removeImageFromNote(note.id, img.url)
  ElMessage.success('已移除')
}

async function clearAll() {
  try {
    await ElMessageBox.confirm(
      `将删除素材库里的全部 ${cachedNotes.value.length} 条笔记及其图片、视频，删除后无法恢复。确定继续吗？`,
      '清空全部内容',
      { confirmButtonText: '确认清空', cancelButtonText: '取消', type: 'warning', confirmButtonClass: 'el-button--danger' },
    )
  } catch {
    return
  }
  await clearAllNotes()
  ElMessage.success('素材库已清空')
}

function formatTime(ts) {
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function liveTotalOf(note) {
  return note.images.filter((img) => img.kind === 'live').length
}

// 文本域随内容增高
function autoGrow() {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 220)}px`
}

const pollTimer = ref(null)

onMounted(async () => {
  cookie.value = localStorage.getItem(COOKIE_KEY) || ''
  try {
    await initMaterials()
  } catch {
    ElMessage.error('素材缓存读取失败，可能被浏览器清空了')
  }
  await refreshHealth()
  // 引擎偶尔启动慢，前 30 秒每 5 秒探一次，之后靠手动刷新
  let attempts = 0
  pollTimer.value = setInterval(async () => {
    attempts += 1
    if (health.value.online || attempts > 6) return clearInterval(pollTimer.value)
    await refreshHealth()
  }, 5000)
})

onBeforeUnmount(() => {
  if (pollTimer.value) clearInterval(pollTimer.value)
})
</script>

<template>
  <section class="page-fetch">
    <header class="page-header">
      <div>
        <h1>素材获取</h1>
        <p class="lede">
          Scrapling 隐身引擎直连点评：扫码登录一次即可长期复用，支持一次贴多条链接批量抓取；笔记里的实况图会连静图一起把短视频抓下来，可悬停预览、单独下载。
        </p>
      </div>
    </header>

    <div class="layout layout-links">
      <aside class="tray">
        <div class="tray-head">
          <h2>抓取任务</h2>
          <span class="engine-pill" :class="engineOnline ? 'is-on' : 'is-off'">
            <span class="engine-dot" aria-hidden="true"></span>
            {{ engineOnline ? '引擎在线' : '引擎离线' }}
          </span>
        </div>

        <div class="engine-card" :class="{ 'is-off': !engineOnline }">
          <div class="engine-row">
            <el-icon class="engine-icon"><Connection /></el-icon>
            <div class="engine-text">
              <strong>{{ engineOnline ? 'Scrapling 已就绪' : 'Scrapling 未启动' }}</strong>
              <p v-if="engineOnline">
                版本 {{ health.version || '未知' }} · 浏览器{{ health.browser ? '可用' : '未安装' }}
              </p>
              <p v-else>在项目根目录执行 <code>npm run scraper</code> 启动本地引擎；未启动时自动降级为 Cookie 抓取。</p>
            </div>
            <el-button size="small" :loading="health.checking" @click="refreshHealth">重试</el-button>
          </div>

          <div v-if="engineOnline" class="engine-login">
            <span class="engine-login-state">
              <el-icon><User /></el-icon>
              {{ login.loggedIn ? `已登录${login.nickname ? ` · ${login.nickname}` : ''}` : '未登录（公开笔记也能抓）' }}
            </span>
            <span class="engine-login-actions">
              <el-button size="small" :loading="loginBusy" @click="startLogin">
                {{ login.loggedIn ? '重新登录' : '扫码登录' }}
              </el-button>
              <el-button v-if="login.loggedIn" size="small" text type="danger" @click="doLogout">退出</el-button>
            </span>
          </div>
        </div>

        <div class="manuscript manuscript-compact">
          <label class="manuscript-label" for="fetch-input">笔记链接（可多条，每行一条）</label>
          <textarea
            id="fetch-input"
            ref="textareaRef"
            v-model="rawText"
            class="manuscript-input"
            placeholder="https://m.dianping.com/feeddetail/516438735&#10;https://m.dianping.com/feeddetail/516438736"
            spellcheck="false"
            @input="autoGrow"
          />
          <div class="meta">
            <span>{{ rawText.length ? `已粘贴 ${rawText.length} 个字` : '等待粘贴' }}</span>
            <span>{{ detected.length ? `识别到 ${detected.length} 条链接` : '未识别到点评链接' }}</span>
          </div>
        </div>

        <div class="fetch-options">
          <el-radio-group v-model="mode" size="small" :disabled="!engineOnline">
            <el-radio-button value="stealth">隐身浏览器</el-radio-button>
            <el-radio-button value="http">快速 HTTP</el-radio-button>
          </el-radio-group>
          <div class="fetch-switches">
            <el-checkbox v-model="withLive" :disabled="!engineOnline">抓取实况图</el-checkbox>
            <el-checkbox v-model="onlyBig">只要大图</el-checkbox>
          </div>
        </div>

        <el-button
          type="primary"
          class="fetch-btn"
          :loading="running"
          :disabled="!detected.length || running"
          @click="startFetch"
        >
          {{ running ? '获取中…' : `开始获取${detected.length ? `（${detected.length} 条）` : ''}` }}
        </el-button>

        <div v-if="!engineOnline" class="fallback-tip">
          <span>正在使用 Cookie 兜底通道，拿不到实况视频。</span>
          <el-button size="small" :class="{ 'cookie-missing': !cookie }" @click="openCookieDialog">
            <el-icon><Setting /></el-icon>
            {{ cookie ? '更新 Cookie' : '填写 Cookie' }}
          </el-button>
        </div>

        <div v-if="jobs.length" class="job-list" role="list">
          <div v-for="job in jobs" :key="job.url" class="job-row" role="listitem">
            <span class="job-state" :class="`is-${job.state}`" aria-hidden="true"></span>
            <div class="job-body">
              <span class="job-url" :title="job.url">{{ job.url }}</span>
              <span class="job-msg" :class="{ 'is-error': job.state === 'error' }">{{ job.message || '排队中' }}</span>
            </div>
          </div>
        </div>

        <div v-else class="empty empty-links">
          <div>
            <el-icon class="empty-icon"><Link /></el-icon>
            <strong>还没有任务</strong>
            <p>贴上链接后点「开始获取」，进度会显示在这里。</p>
          </div>
        </div>
      </aside>

      <div class="stage-wrap">
        <div class="materials-stage">
          <div class="materials-toolbar">
            <h2>
              素材库 <span class="materials-count">{{ cachedNotes.length }}</span>
            </h2>
            <div class="materials-tools">
              <el-button v-if="cachedNotes.length" size="small" :class="{ 'cookie-missing': !engineOnline && !cookie }" @click="engineOnline ? startLogin() : openCookieDialog()">
                <el-icon><Setting /></el-icon>
                {{ engineOnline ? (login.loggedIn ? '已登录' : '扫码登录') : cookie ? '已登录' : '填写 Cookie' }}
              </el-button>
              <el-button v-if="cachedNotes.length" type="danger" size="small" @click="clearAll">清空全部内容</el-button>
            </div>
          </div>

          <div v-if="cachedNotes.length" class="material-cards">
            <div v-for="note in cachedNotes" :key="note.id" class="material-row">
              <article class="material-card">
                <div class="material-gallery">
                  <div v-if="note.images.length" class="material-thumbs">
                    <div
                      v-for="(img, i) in note.images"
                      :key="img.url + i"
                      class="material-thumb-wrap"
                      :class="{ 'is-live': img.kind === 'live' }"
                      role="button"
                      tabindex="0"
                      :title="img.kind === 'live' ? '实况图：悬停播放，点击放大' : '点击放大预览'"
                      @click="img.kind === 'live' ? openLivePreview(note, img) : openPreview(note, i)"
                      @keydown.enter.prevent="img.kind === 'live' ? openLivePreview(note, img) : openPreview(note, i)"
                      @mouseenter="img.kind === 'live' && (img.live?.videoSrc || img.live?.videoUrl) ? playHover($event) : null"
                      @mouseleave="img.kind === 'live' ? stopHover($event) : null"
                    >
                      <el-image v-if="img.kind !== 'video'" class="material-thumb" :src="displaySrc(note, img)" fit="cover" lazy>
                        <template #error>
                          <div class="material-thumb material-thumb-broken">加载失败</div>
                        </template>
                      </el-image>
                      <div v-else class="material-thumb material-thumb-video">
                        <el-icon><VideoCamera /></el-icon>
                      </div>

                      <video
                        v-if="img.kind === 'live' && (img.live?.videoSrc || img.live?.videoUrl)"
                        class="live-hover-video"
                        :src="img.live.videoSrc || mediaUrl(img.live.videoUrl)"
                        muted
                        loop
                        playsinline
                        preload="none"
                      ></video>

                      <span v-if="img.kind === 'live'" class="live-badge">
                        <el-icon><VideoPlay /></el-icon>
                        实况
                      </span>
                      <button class="thumb-remove" type="button" title="移除" @click.stop="removeImage(note, img)">×</button>
                    </div>
                  </div>
                  <div v-else class="empty">
                    <el-icon class="empty-icon"><Picture /></el-icon>
                    <p>这条笔记没有留下大图</p>
                  </div>
                </div>
              </article>

              <aside class="material-info">
                <div v-if="note.shop" class="info-block">
                  <span class="info-label">店铺信息</span>
                  <div class="shop-card">
                    <strong v-if="note.shop.name" class="shop-name">{{ note.shop.name }}</strong>
                    <div v-if="note.shop.address" class="shop-addr">{{ note.shop.address }}</div>
                  </div>
                </div>

                <div class="material-actions">
                  <span class="source-tag" :class="`is-${note.source}`">
                    {{ note.source === 'scrapling' ? 'Scrapling' : 'Cookie' }}
                  </span>
                  <span v-if="liveTotalOf(note)" class="live-count">{{ liveTotalOf(note) }} 张实况</span>
                  <span class="material-time">{{ formatTime(note.fetchedAt) }}</span>
                  <el-button size="small" text @click="refetchNote(note)">
                    <el-icon><Refresh /></el-icon>
                    重新获取
                  </el-button>
                </div>

                <div class="info-block">
                  <span class="info-label">标题</span>
                  <p class="info-title">{{ note.title }}</p>
                </div>

                <div v-if="note.content" class="info-block info-block-grow">
                  <span class="info-label">笔记内容</span>
                  <p class="info-content">{{ note.content }}</p>
                </div>

                <div v-if="liveTotalOf(note)" class="live-actions">
                  <span class="info-label">实况图下载</span>
                  <div class="live-action-list">
                    <template v-for="(img, i) in note.images" :key="`live-${img.url}-${i}`">
                      <div v-if="img.kind === 'live'" class="live-action-row">
                        <span class="live-action-index">#{{ i + 1 }}</span>
                        <el-button size="small" :disabled="!img.blob" @click="downloadStill(note, img)">
                          <el-icon><Download /></el-icon>
                          静图
                        </el-button>
                        <el-button size="small" :disabled="!img.live?.videoBlob" @click="downloadVideo(note, img)">
                          <el-icon><VideoCamera /></el-icon>
                          视频
                        </el-button>
                        <span v-if="img.live?.duration" class="live-duration">{{ img.live.duration.toFixed(1) }}s</span>
                      </div>
                    </template>
                  </div>
                </div>
              </aside>
            </div>
          </div>

          <div v-else class="empty">
            <div>
              <el-icon class="empty-icon"><Picture /></el-icon>
              <strong>素材库还是空的</strong>
              <p>左侧贴上点评笔记链接，点「开始获取」后会按笔记整理在这里。</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <el-dialog v-model="cookieDialogVisible" title="点评 Cookie（兜底通道）" width="min(560px, 92vw)">
      <p class="api-dialog-note">
        只有引擎未启动时才需要它。Cookie 只保存在本机浏览器，用于本地代理转发请求，不上传任何服务器。
      </p>
      <el-input v-model="cookieInput" type="textarea" :rows="5" placeholder="粘贴 Cookie 字符串，例如：_lxsdk_cuid=...; cy=...; dper=..." />
      <template #footer>
        <el-button @click="cookieDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveCookie">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog
      :model-value="Boolean(livePreview)"
      title="实况图预览"
      width="min(720px, 94vw)"
      @update:model-value="(v) => { if (!v) livePreview = null }"
    >
      <div v-if="livePreview" class="live-preview-body">
        <video
          v-if="livePreview.image.live?.videoSrc || livePreview.image.live?.videoUrl"
          class="live-preview-video"
          :src="livePreview.image.live.videoSrc || mediaUrl(livePreview.image.live.videoUrl)"
          :poster="livePreview.image.src"
          controls
          autoplay
          loop
          playsinline
        ></video>
        <img v-else class="live-preview-video" :src="livePreview.image.src" alt="" />
        <p class="live-preview-tip">
          上方播放的就是这条笔记的实况视频，静图作为封面。原平台把两者存在一起，下载后可按需合成。
        </p>
      </div>
      <template #footer>
        <el-button @click="livePreview = null">关闭</el-button>
        <el-button :disabled="!livePreview?.image.blob" @click="downloadStill(previewNote || { id: 'live' }, livePreview.image)">
          <el-icon><Download /></el-icon>
          下载静图
        </el-button>
        <el-button
          type="primary"
          :disabled="!livePreview?.image.live?.videoBlob"
          @click="downloadVideo({ id: 'live' }, livePreview.image)"
        >
          <el-icon><VideoCamera /></el-icon>
          下载实况视频
        </el-button>
      </template>
    </el-dialog>

    <ImageZoomPreview
      v-model="previewIndex"
      :images="previewNote?.images || []"
      :download-name="previewNote ? `点评素材-${previewNote.id}` : '点评素材'"
    />
  </section>
</template>
