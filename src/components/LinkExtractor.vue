<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CopyDocument, Link, Picture, Setting } from '@element-plus/icons-vue'
import { extractLinks } from '../utils/extractLinks'
import { extractFeedId, isDianpingUrl, normalizeNoteUrl, parseFeedHtml } from '../utils/dianping'
import ImageZoomPreview from './ImageZoomPreview.vue'
import {
  cachedNotes,
  clearAllNotes,
  deleteNote,
  initMaterials,
  removeImageFromNote,
  upsertNote,
} from '../stores/materials'

const rawText = ref('')
const textareaRef = ref(null)

const result = computed(() => extractLinks(rawText.value, { dedupe: true }))
// 一次只处理一条链接：取识别到的第一条
const link = computed(() => result.value.items[0] || null)

// ---------- 点评登录态（手动 Cookie）----------

const COOKIE_KEY = 'dianping-cookie'
const dpCookie = ref('')
const cookieDialogVisible = ref(false)
const cookieInput = ref('')

const hasLogin = computed(() => Boolean(dpCookie.value))

function openCookieDialog() {
  cookieInput.value = dpCookie.value
  cookieDialogVisible.value = true
}

function saveCookie() {
  const value = cookieInput.value.trim()
  if (value) {
    dpCookie.value = value
    localStorage.setItem(COOKIE_KEY, value)
    ElMessage.success('Cookie 已保存，只存在本机浏览器里')
  } else {
    dpCookie.value = ''
    localStorage.removeItem(COOKIE_KEY)
    ElMessage.info('已清空 Cookie')
  }
  cookieDialogVisible.value = false
}

// ---------- 素材抓取 ----------

const fetchStatus = ref({}) // url -> { state: 'loading' | 'error', message }
const fetching = computed(() => Boolean(link.value && fetchStatus.value[link.value.url]?.state === 'loading'))

// 只要美食大图：任一边不大于该值的（头像、图标、码）直接丢弃，>500 才列入清单
const MIN_FOOD_SIDE = 500

// 文本域随内容自动增高，内部不出现滚动条
watch(
  rawText,
  () => {
    const el = textareaRef.value
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  },
  { flush: 'post' },
)

onMounted(async () => {
  dpCookie.value = localStorage.getItem(COOKIE_KEY) || ''
  try {
    await initMaterials()
  } catch {
    ElMessage.error('素材缓存读取失败，可能被浏览器清空了')
  }
})

// 把 CDN 图片经本地代理转成 blob，存进 IndexedDB 后刷新也不丢
async function downloadImages(urls) {
  const images = new Array(urls.length)
  let cursor = 0
  async function worker() {
    while (cursor < urls.length) {
      const slot = cursor++
      const url = urls[slot]
      try {
        const res = await fetch(`/api/dp/image?url=${encodeURIComponent(url)}`)
        if (!res.ok) throw new Error(`图片拉取失败 ${res.status}`)
        images[slot] = { url, blob: await res.blob() }
      } catch {
        // 单张失败不阻塞整条笔记，保留远程地址兜底展示
        images[slot] = { url, blob: null }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, urls.length) }, worker))
  return images
}

async function blobMinSide(blob) {
  if (!blob) return Infinity
  try {
    const bitmap = await createImageBitmap(blob)
    const min = Math.min(bitmap.width, bitmap.height)
    bitmap.close?.()
    return min
  } catch {
    return Infinity
  }
}

// 过滤小图标（头像/装饰/码），只留美食大图；带上宽高方便预览提示
async function keepFoodImages(images) {
  const kept = []
  let dropped = 0
  for (const img of images) {
    const minSide = await blobMinSide(img.blob)
    if (minSide > MIN_FOOD_SIDE) {
      try {
        const bitmap = await createImageBitmap(img.blob)
        kept.push({ ...img, width: bitmap.width, height: bitmap.height })
        bitmap.close?.()
      } catch {
        kept.push(img)
      }
    } else {
      dropped++
    }
  }
  return { kept, dropped }
}

async function fetchMaterial(item) {
  if (!hasLogin.value) {
    ElMessage.warning('先填写点评 Cookie（已登录状态下的），才能抓到笔记内容')
    openCookieDialog()
    return
  }
  const targetUrl = normalizeNoteUrl(item.url)
  fetchStatus.value = { ...fetchStatus.value, [item.url]: { state: 'loading' } }
  try {
    const res = await fetch('/api/dp/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: targetUrl, cookie: dpCookie.value }),
    })
    const data = await res.json()
    if (data.error === 'LOGIN_REQUIRED') {
      fetchStatus.value = { ...fetchStatus.value, [item.url]: { state: 'error', message: '登录态失效' } }
      ElMessage.error('点评要求重新登录：请在浏览器里重新登录后更新 Cookie')
      openCookieDialog()
      return
    }
    if (data.error) throw new Error(data.message || data.error)

    const parsed = parseFeedHtml(data.html)
    if (parsed.loginRequired) {
      fetchStatus.value = { ...fetchStatus.value, [item.url]: { state: 'error', message: '登录态失效' } }
      ElMessage.error('页面被重定向到登录页，请更新 Cookie')
      openCookieDialog()
      return
    }
    if (!parsed.images.length && !parsed.content) {
      throw new Error('没解析到图文素材，笔记可能已删除或被设为仅自己可见')
    }

    const { kept, dropped } = await keepFoodImages(await downloadImages(parsed.images))
    const id = extractFeedId(item.url) || item.url
    const note = {
      id,
      url: item.url,
      title: parsed.title || `笔记 ${id}`,
      content: parsed.content,
      shop: parsed.shop,
      images: kept,
      fetchedAt: Date.now(),
    }
    await upsertNote(note)
    fetchStatus.value = { ...fetchStatus.value, [item.url]: { state: 'done' } }
    const filtered = dropped ? `（过滤 ${dropped} 张小图）` : ''
    ElMessage.success(`已获取「${note.title}」：${kept.length} 张美食图 + 文案${filtered}`)
  } catch (err) {
    fetchStatus.value = { ...fetchStatus.value, [item.url]: { state: 'error', message: String(err.message || err) } }
    ElMessage.error(String(err.message || err))
  }
}

async function fetchLink() {
  if (!link.value || fetching.value) return
  if (!isDianpingUrl(link.value.url)) {
    ElMessage.warning('目前只支持大众点评笔记链接（m.dianping.com）')
    return
  }
  await fetchMaterial(link.value)
}

// 工具栏「重新获取」：按新解析规则重抓素材库里的全部笔记
const refetching = ref(false)

async function refetchAll() {
  if (refetching.value) return
  if (!hasLogin.value) {
    ElMessage.warning('先填写点评 Cookie 才能重新获取')
    openCookieDialog()
    return
  }
  refetching.value = true
  try {
    for (const note of [...cachedNotes.value]) {
      await fetchMaterial({ url: note.url })
    }
  } finally {
    refetching.value = false
  }
}

function refetchNote(note) {
  fetchMaterial({ url: note.url })
}

async function removeImage(note, img) {
  await removeImageFromNote(note.id, img.url)
  ElMessage.success('已移除这张图')
}

async function clearMaterials() {
  await clearAllNotes()
  ElMessage.success('素材库已清空')
}

// 清空全部 / 删除单条都是不可恢复的操作，先弹确认框，取消就什么都不做
async function confirmClearAll() {
  try {
    await ElMessageBox.confirm(
      `将删除素材库里的全部 ${cachedNotes.value.length} 条笔记及其图片，删除后无法恢复。确定继续吗？`,
      '清空全部内容',
      {
        confirmButtonText: '确认清空',
        cancelButtonText: '取消',
        type: 'warning',
        confirmButtonClass: 'el-button--danger',
      },
    )
  } catch {
    return
  }
  await clearMaterials()
}

async function confirmDeleteNote(note) {
  const label = note.title.length > 24 ? `${note.title.slice(0, 24)}…` : note.title
  try {
    await ElMessageBox.confirm(
      `确定删除「${label}」这条笔记及其 ${note.images.length} 张图片吗？删除后无法恢复。`,
      '删除这条笔记',
      {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning',
        confirmButtonClass: 'el-button--danger',
      },
    )
  } catch {
    return
  }
  await deleteNote(note.id)
  ElMessage.success('已删除这条笔记')
}

// ---------- 图片放大预览 ----------

const previewNote = ref(null)
const previewIndex = ref(-1)

function openPreview(note, index) {
  previewNote.value = note
  previewIndex.value = index
}

function formatTime(ts) {
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// ---------- 复制 ----------

async function copyText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(successMessage)
  } catch {
    // 非安全上下文（如 file://）下的兜底方案
    const holder = document.createElement('textarea')
    holder.value = text
    holder.style.position = 'fixed'
    holder.style.opacity = '0'
    document.body.appendChild(holder)
    holder.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(holder)
    if (ok) ElMessage.success(successMessage)
    else ElMessage.error('复制失败，请手动选择链接复制')
  }
}

function copyOne(item) {
  copyText(item.url, '链接已复制')
}
</script>

<template>
  <section class="page-links">
    <header class="page-header">
      <div>
        <h1>素材提取</h1>
        <p class="lede">
          粘贴文案自动识别出点评笔记链接，一键抓取图文素材、只留美食大图；右侧素材库铺满展示，点击可放大预览，也能带到「美食AI / 拼图 / 双拼 / 倒影」页面使用。
        </p>
      </div>
    </header>

    <div class="layout layout-links">
      <aside class="tray">
        <h2>素材提取</h2>
        <p class="hint">粘贴带点评笔记的文案，自动识别出第一条链接，一次处理一条。</p>

        <div class="manuscript manuscript-compact">
          <label class="manuscript-label" for="copy-input">原文案</label>
          <textarea
            id="copy-input"
            ref="textareaRef"
            v-model="rawText"
            class="manuscript-input"
            placeholder="粘贴文案，例如：&#10;笔记 https://m.dianping.com/feeddetail/516438735"
            spellcheck="false"
          />
          <div class="meta">
            <span>{{ rawText.length ? `已粘贴 ${rawText.length} 个字` : '等待粘贴' }}</span>
            <span>{{ link ? '已识别 1 条链接' : '未识别到链接' }}</span>
          </div>
        </div>

        <div v-if="link" class="link-list" role="list">
          <div class="link-row" role="listitem">
            <div class="link-body">
              <a class="link-url" :href="link.url" target="_blank" rel="noopener noreferrer">{{ link.url }}</a>
              <span v-if="link.context" class="link-context">第 {{ link.line }} 行 · {{ link.context }}</span>
              <span v-if="fetchStatus[link.url]?.state === 'error'" class="link-fetch-error">
                {{ fetchStatus[link.url].message }}
              </span>
            </div>
            <button class="copy-one" type="button" title="复制这条链接" @click="copyOne(link)">
              <el-icon><CopyDocument /></el-icon>
            </button>
          </div>
        </div>
        <div v-else class="empty empty-links">
          <el-icon class="empty-icon"><Link /></el-icon>
          <div>
            <strong>还没有识别到链接</strong>
            <p>文案里包含 http 或 www 开头的地址就会显示在这里。</p>
          </div>
        </div>

        <el-button
          type="primary"
          class="fetch-btn"
          :disabled="!link || fetching"
          :loading="fetching"
          @click="fetchLink"
        >
          {{ fetching ? '正在获取素材…' : '一键获取素材' }}
        </el-button>

        <div class="note">
          点评笔记需要登录态：点「填写 Cookie」按步骤复制即可。抓取依赖本地代理，请通过 npm run dev 访问本页。
        </div>
      </aside>

      <div class="stage-wrap">
        <div class="materials-stage">
          <div class="materials-toolbar">
            <h2>点评素材库 <span class="materials-count">{{ cachedNotes.length }}</span></h2>
            <div class="materials-tools">
              <el-button v-if="cachedNotes.length" size="small" :loading="refetching" @click="refetchAll">
                重新获取
              </el-button>
              <el-button size="small" :class="{ 'cookie-missing': !hasLogin }" @click="openCookieDialog">
                <el-icon class="btn-icon"><Setting /></el-icon>
                {{ hasLogin ? '已登录' : '填写 Cookie' }}
              </el-button>
              <el-button v-if="cachedNotes.length" size="small" @click="confirmClearAll">
                清空全部内容
              </el-button>
            </div>
          </div>
          <p class="stage-hint">
            {{ link ? '已识别 1 条点评笔记链接' : '左侧粘贴点评笔记链接后，可在这里抓取图文' }}；只保留边长大于 500px 的图片，悬停可单张移除，点击可放大预览。
          </p>

          <div v-if="cachedNotes.length" class="material-cards">
            <div v-for="note in cachedNotes" :key="note.id" class="material-row">
              <article class="material-card">
                <div class="material-gallery">
                  <div v-if="note.images.length" class="material-thumbs">
                    <div
                      v-for="(img, i) in note.images"
                      :key="img.url + i"
                      class="material-thumb-wrap"
                      role="button"
                      tabindex="0"
                      title="点击放大预览"
                      @click="openPreview(note, i)"
                      @keydown.enter.prevent="openPreview(note, i)"
                    >
                      <el-image
                        class="material-thumb"
                        :src="img.src"
                        fit="cover"
                        lazy
                        :title="img.width ? `${img.width}×${img.height}` : undefined"
                      >
                        <template #error>
                          <div class="material-thumb material-thumb-broken">加载失败</div>
                        </template>
                      </el-image>
                      <button class="thumb-remove" type="button" title="移除这张图" @click.stop="removeImage(note, img)">×</button>
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
                    <strong
                      v-if="note.shop.name"
                      class="shop-name copyable"
                      title="点击复制店名"
                      @click="copyText(note.shop.name, '店名已复制')"
                    >{{ note.shop.name }}</strong>
                    <div
                      v-if="note.shop.address"
                      class="shop-addr copyable"
                      title="点击复制地址"
                      @click="copyText(note.shop.address, '地址已复制')"
                    >{{ note.shop.address }}</div>
                  </div>
                </div>

                <div class="material-actions">
                  <div class="material-action-btns">
                    <el-button size="small" type="danger" plain @click="confirmDeleteNote(note)">删除</el-button>
                  </div>
                  <span class="material-time">{{ formatTime(note.fetchedAt) }}</span>
                </div>

                <div class="info-block">
                  <span class="info-label">标题</span>
                  <p
                    class="info-title copyable"
                    title="点击复制标题"
                    @click="copyText(note.title, '标题已复制')"
                  >{{ note.title }}</p>
                </div>

                <div v-if="note.content" class="info-block info-block-grow">
                  <span class="info-label">笔记内容</span>
                  <p
                    class="info-content copyable"
                    title="点击复制全部文案"
                    @click="copyText(note.content, '笔记文案已复制')"
                  >{{ note.content }}</p>
                </div>
              </aside>
            </div>
          </div>
          <div v-else class="empty">
            <el-icon class="empty-icon"><Picture /></el-icon>
            <div>
              <strong>素材库还是空的</strong>
              <p>左侧粘贴点评笔记链接，点「一键获取素材」后，图文会按笔记整理在这里。</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <el-dialog v-model="cookieDialogVisible" title="点评登录态（Cookie）" width="min(560px, 92vw)">
      <p class="api-dialog-note">
        抓取笔记要求已登录大众点评。本工具不上传任何数据，Cookie 只保存在本机浏览器，用于本地代理转发请求。
      </p>
      <ol class="cookie-steps">
        <li>在当前浏览器新开一个标签页，打开 m.dianping.com 并登录（手机扫码即可）；</li>
        <li>按 F12 打开开发者工具，切到「网络 / Network」，随便刷新一次页面；</li>
        <li>点击第一个 dianping.com 请求，在「请求标头」里找到 <code>Cookie:</code> 那一行；</li>
        <li>整行值复制下来，粘贴到下面保存。</li>
      </ol>
      <el-input
        v-model="cookieInput"
        type="textarea"
        :rows="5"
        placeholder="粘贴 Cookie 字符串，例如：_lxsdk_cuid=...; cy=...; dper=..."
      />
      <template #footer>
        <el-button @click="cookieDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveCookie">保存</el-button>
      </template>
    </el-dialog>

    <ImageZoomPreview
      v-model="previewIndex"
      :images="previewNote?.images || []"
      :download-name="previewNote ? `点评素材-${previewNote.id}` : '点评素材'"
    />
  </section>
</template>
