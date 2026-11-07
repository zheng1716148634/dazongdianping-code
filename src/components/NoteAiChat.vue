<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { ChatDotRound, CopyDocument, Promotion, RefreshLeft, Setting } from '@element-plus/icons-vue'

// 文生文 AI 对话框：针对单条笔记内容做多轮改写。
// 接口约定与「美食AI」页一致：OpenAI 兼容的 /chat/completions，浏览器直连，
// baseUrl / API Key / 模型只存在本机 localStorage，不经任何服务器中转。

const props = defineProps({
  visible: { type: Boolean, default: false },
  note: { type: Object, default: null }, // { id, title, content }
})

const emit = defineEmits(['update:visible', 'apply'])

const CONFIG_KEY = 'note-ai-config'

const chatVisible = computed({
  get: () => props.visible,
  set: (value) => emit('update:visible', value),
})

// ---------- 接口配置 ----------

const configVisible = ref(false)
const configForm = ref({ baseUrl: '', apiKey: '', model: '' })
const configModels = ref([])
const configTesting = ref(false)
const configFetching = ref(false)
const configState = ref({ state: 'idle', text: '' })

const storedConfig = loadConfig()
const config = ref(storedConfig)

const hasConfig = computed(
  () => Boolean(config.value.baseUrl.trim() && config.value.apiKey.trim() && config.value.model.trim()),
)

function loadConfig() {
  try {
    const raw = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null')
    if (raw && typeof raw === 'object') {
      return {
        baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
        apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
        model: typeof raw.model === 'string' ? raw.model : '',
        models: Array.isArray(raw.models) ? raw.models.filter((id) => typeof id === 'string') : [],
      }
    }
  } catch {
    /* 本地数据损坏时忽略 */
  }
  return { baseUrl: '', apiKey: '', model: '', models: [] }
}

function persistConfig() {
  try {
    localStorage.setItem(
      CONFIG_KEY,
      JSON.stringify({
        baseUrl: config.value.baseUrl,
        apiKey: config.value.apiKey,
        model: config.value.model,
        models: config.value.models,
      }),
    )
  } catch {
    /* 存储不可用时忽略，本次仍可用 */
  }
}

function openConfig() {
  configForm.value = {
    baseUrl: config.value.baseUrl,
    apiKey: config.value.apiKey,
    model: config.value.model,
  }
  configModels.value = [...config.value.models]
  configState.value = { state: 'idle', text: '' }
  configVisible.value = true
}

function saveConfig() {
  const form = configForm.value
  if (!form.baseUrl.trim() || !form.apiKey.trim() || !form.model.trim()) {
    ElMessage.warning('接口地址、API Key 和模型都要填写')
    return
  }
  config.value = {
    baseUrl: form.baseUrl.trim(),
    apiKey: form.apiKey.trim(),
    model: form.model.trim(),
    models: [...configModels.value],
  }
  persistConfig()
  configVisible.value = false
  ElMessage.success('AI 接口配置已保存在本机浏览器')
}

function normalizeBase(url) {
  return url.trim().replace(/\/+$/, '')
}

// 拉取模型列表，「测试连接」和「获取模型」共用
async function requestModels(form) {
  const base = normalizeBase(form.baseUrl)
  const key = form.apiKey.trim()
  if (!base) throw new Error('先填写接口地址（含 /v1）')
  if (!key) throw new Error('先填写 API Key')

  let response
  try {
    response = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } })
  } catch {
    throw new Error('无法连接：请检查地址是否可达、是否允许浏览器跨域（CORS）请求')
  }

  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`API Key 无效或没有权限（HTTP ${response.status}）`)
    }
    if (response.status === 404) {
      throw new Error('地址可达，但该接口没有提供 /models 列表，可手动填写模型 ID')
    }
    const detail = payload?.error?.message || payload?.message || `HTTP ${response.status}`
    throw new Error(`接口返回错误：${detail}`)
  }

  const ids = Array.isArray(payload?.data)
    ? payload.data.map((item) => item?.id).filter((id) => typeof id === 'string')
    : []
  if (!ids.length) throw new Error('接口返回成功，但没有解析到模型列表（data[].id）')
  return ids
}

async function testConfig() {
  if (configTesting.value) return
  configTesting.value = true
  configState.value = { state: 'pending', text: '正在测试连接…' }
  try {
    const ids = await requestModels(configForm.value)
    configModels.value = ids
    configState.value = { state: 'ok', text: `连接正常，共 ${ids.length} 个模型` }
  } catch (error) {
    configState.value = { state: 'error', text: error.message }
  } finally {
    configTesting.value = false
  }
}

async function fetchConfigModels() {
  if (configFetching.value) return
  configFetching.value = true
  configState.value = { state: 'pending', text: '正在获取模型列表…' }
  try {
    const ids = await requestModels(configForm.value)
    configModels.value = ids
    if (!configForm.value.model.trim() || !ids.includes(configForm.value.model.trim())) {
      configForm.value.model = ids[0] || ''
    }
    configState.value = { state: 'ok', text: `已获取 ${ids.length} 个模型，在下拉里选一个即可` }
  } catch (error) {
    configState.value = { state: 'error', text: error.message }
  } finally {
    configFetching.value = false
  }
}

// ---------- 对话 ----------

// 当前参与改写的笔记文案：打开时取自笔记，「应用到笔记」成功后跟随更新
const currentContent = ref('')
const messages = ref([]) // { id, role, content(原始全文), title(解析出的标题), display(展示正文), error? }
const input = ref('')
const sending = ref(false)
const chatBodyRef = ref(null)

const PRESETS = [
  [
    '按小红书爆款笔记的格式改写：',
    '标题吸睛并带 1~2 个 emoji；',
    '正文开头一句话抓住眼球，中间分成 3~5 个小段，每段开头用一个贴切的 emoji 点缀，多用短句和换行，节奏轻快；整体口语化一些像是正常分享的语气',
    '结尾加一句互动提问（比如引导评论）；',
    '最后另起一行附 3~5 个相关话题标签，格式如 #美食探店 #周末去哪吃，标签数量不超过 5 个。',
  ].join(''),
]

const noteLabel = computed(() => {
  const title = props.note?.title || ''
  return title.length > 18 ? `${title.slice(0, 18)}…` : title
})

watch(
  () => [props.visible, props.note?.id],
  ([visible]) => {
    if (visible && props.note) {
      currentContent.value = props.note.content || ''
      messages.value = []
      input.value = ''
      sending.value = false
    }
  },
)

// 「应用到笔记」成功后父组件会更新 note.content，这里保持同步
watch(
  () => props.note?.content,
  (value) => {
    if (props.visible && value != null) currentContent.value = value
  },
)

function buildSystemPrompt() {
  return [
    '你是一位大众点评美食笔记的文案改写助手。下面提供这条笔记的标题和原文，用户会提出改写要求（如换语气、增删细节、控制字数等），你需要同时改写标题和正文。',
    '输出格式固定如下，两段标记缺一不可，标记之外不要输出任何解释、引号或额外内容：',
    '【标题】改写后的标题',
    '【正文】改写后的完整正文',
    '要求：标题简短抓眼球（20 字以内为佳）；正文保持真实口语感、符合社区表达习惯；没有提出字数要求时正文篇幅与原文相当；用户明确指定风格或格式（如小红书格式）时，以用户要求为准。',
    '',
    '【笔记标题】',
    props.note?.title || '（无标题）',
    '',
    '【笔记原文】',
    currentContent.value || '（无内容）',
  ].join('\n')
}

// 从 AI 回复里拆出标题和正文；模型没按格式输出时整体当作正文
function parseRewrite(text) {
  const source = String(text).trim()
  const titleMatch = source.match(/【标题】\s*([\s\S]*?)(?=\s*【正文】|$)/)
  const bodyMatch = source.match(/【正文】\s*([\s\S]*)$/)
  if (titleMatch && bodyMatch) {
    return { title: titleMatch[1].trim(), display: bodyMatch[1].trim() }
  }
  return { title: '', display: source }
}

// 还原成带标记的完整文本，用于多轮对话的上下文
function messageRaw(message) {
  return message.title ? `【标题】${message.title}\n【正文】${message.display}` : message.display
}

async function scrollToBottom() {
  await nextTick()
  const el = chatBodyRef.value
  if (el) el.scrollTop = el.scrollHeight
}

let messageSeq = 0
function createMessage(role, content) {
  messageSeq += 1
  return { id: `msg-${Date.now().toString(36)}-${messageSeq}`, role, content, title: '', display: content }
}

async function send(text) {
  const prompt = (typeof text === 'string' ? text : input.value).trim()
  if (!prompt || sending.value) return
  if (!currentContent.value.trim() && !props.note?.title?.trim()) {
    ElMessage.warning('这条笔记没有标题和文案，没法改写')
    return
  }
  if (!hasConfig.value) {
    ElMessage.warning('先配置文生文 AI 的接口和 Key')
    openConfig()
    return
  }

  input.value = ''
  messages.value.push(createMessage('user', prompt))
  const pending = createMessage('assistant', '')
  messages.value.push(pending)
  sending.value = true
  await scrollToBottom()

  try {
    const base = normalizeBase(config.value.baseUrl)
    const history = messages.value
      .filter((item) => item !== pending && !item.error && item.display)
      .map((item) => ({ role: item.role, content: messageRaw(item) }))
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.value.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: config.value.model,
        messages: [{ role: 'system', content: buildSystemPrompt() }, ...history],
        temperature: 0.8,
      }),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.message || `HTTP ${response.status}`
      throw new Error(detail)
    }
    const content = payload?.choices?.[0]?.message?.content
    if (!content || !String(content).trim()) throw new Error('接口返回了空内容')
    const parsed = parseRewrite(content)
    pending.title = parsed.title
    pending.display = parsed.display
  } catch (error) {
    const message = String(error.message || error)
    pending.display = `改写失败：${message}`
    pending.error = true
  } finally {
    sending.value = false
    await scrollToBottom()
  }
}

function usePreset(text) {
  if (sending.value) return
  input.value = text
}

function clearChat() {
  if (sending.value) return
  messages.value = []
  input.value = ''
}

async function copyMessage(message) {
  const text = message.title ? `${message.title}\n\n${message.display}` : message.display
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('已复制')
  } catch {
    ElMessage.error('复制失败，请手动选择文本复制')
  }
}

// 把 AI 的改写结果交给父组件写回素材库（父组件负责确认与保存）
function applyMessage(message) {
  if (message.error || !message.display?.trim()) return
  emit('apply', { title: message.title, content: message.display })
}

function formatStateClass(state) {
  return { ok: state.state === 'ok', error: state.state === 'error' }
}
</script>

<template>
  <el-dialog
    v-model="chatVisible"
    :title="`AI 笔记改写${noteLabel ? ` · ${noteLabel}` : ''}`"
    width="min(640px, 94vw)"
    :close-on-click-modal="false"
    class="note-ai-dialog"
  >
    <div class="note-ai-toolbar">
      <span class="note-ai-config-state" :class="hasConfig ? 'is-ok' : 'is-missing'">
        {{ hasConfig ? `当前模型：${config.model}` : '还没配置文生文 AI 接口' }}
      </span>
      <div class="note-ai-toolbar-btns">
        <el-button size="small" :disabled="sending || !messages.length" @click="clearChat">
          <el-icon class="btn-icon"><RefreshLeft /></el-icon>
          清空对话
        </el-button>
        <el-button size="small" @click="openConfig">
          <el-icon class="btn-icon"><Setting /></el-icon>
          接口设置
        </el-button>
      </div>
    </div>

    <div class="note-ai-context">
      <div class="note-ai-context-head">
        <span class="note-ai-context-label">改写对象 · 已自动带入</span>
        <span class="note-ai-context-hint">AI 会同时改写标题和正文</span>
      </div>
      <p class="note-ai-context-title">{{ props.note?.title || '（无标题）' }}</p>
    </div>

    <div ref="chatBodyRef" class="note-ai-body">
      <div v-if="!messages.length" class="note-ai-empty">
        <el-icon class="note-ai-empty-icon"><ChatDotRound /></el-icon>
        <strong>在下方输入框写改写要求</strong>
        <p>标题和正文会一起改写，可多轮调整，满意后一键应用回素材库。</p>
        <div class="note-ai-presets">
          <button
            v-for="preset in PRESETS"
            :key="preset"
            class="note-ai-preset"
            type="button"
            @click="usePreset(preset)"
          >
            {{ preset }}
          </button>
        </div>
      </div>

      <template v-else>
        <div
          v-for="message in messages"
          :key="message.id"
          class="note-ai-msg"
          :class="`note-ai-msg-${message.role}`"
        >
          <div class="note-ai-bubble" :class="{ 'is-error': message.error }">
            <strong v-if="message.title" class="note-ai-bubble-title">{{ message.title }}</strong>
            <span>{{ message.display || (message.role === 'assistant' ? '思考中…' : '') }}</span>
          </div>
          <div v-if="message.display" class="note-ai-msg-tools">
            <button
              v-if="message.display && !message.error"
              class="note-ai-tool"
              type="button"
              title="复制这条内容"
              @click="copyMessage(message)"
            >
              <el-icon><CopyDocument /></el-icon>
              复制
            </button>
            <button
              v-if="message.role === 'assistant' && message.display && !message.error"
              class="note-ai-tool note-ai-tool-apply"
              type="button"
              title="用这条改写结果替换笔记的标题和内容"
              @click="applyMessage(message)"
            >
              应用到笔记
            </button>
          </div>
        </div>
      </template>
    </div>

    <div class="note-ai-input">
      <el-input
        v-model="input"
        type="textarea"
        :rows="2"
        resize="none"
        placeholder="输入改写要求，Enter 发送，Shift + Enter 换行"
        @keydown.enter.exact.prevent="send()"
      />
      <el-button
        type="primary"
        class="note-ai-send"
        :loading="sending"
        :disabled="!input.trim()"
        @click="send()"
      >
        <template v-if="!sending">
          <el-icon class="btn-icon"><Promotion /></el-icon>
          发送
        </template>
        <template v-else>改写中…</template>
      </el-button>
    </div>

    <el-dialog v-model="configVisible" title="文生文 AI 接口设置" width="min(520px, 92vw)" append-to-body>
      <p class="api-dialog-note">
        填一个 OpenAI 兼容的对话接口（chat/completions）。配置和 Key 只保存在本机浏览器，请求由页面直接发出。
      </p>
      <el-form label-position="top" class="note-ai-config-form">
        <el-form-item label="接口地址（Base URL，含 /v1）">
          <el-input v-model="configForm.baseUrl" placeholder="例如：https://api.openai.com/v1" clearable />
        </el-form-item>
        <el-form-item label="API Key">
          <el-input v-model="configForm.apiKey" type="password" show-password placeholder="sk-..." clearable />
        </el-form-item>
        <el-form-item label="模型">
          <div class="note-ai-model-row">
            <el-select
              v-model="configForm.model"
              filterable
              allow-create
              default-first-option
              placeholder="获取列表后选择，或手动输入模型 ID"
              class="note-ai-model-select"
            >
              <el-option v-for="id in configModels" :key="id" :label="id" :value="id" />
            </el-select>
            <el-button :loading="configFetching" @click="fetchConfigModels">获取模型</el-button>
            <el-button :loading="configTesting" @click="testConfig">测试连接</el-button>
          </div>
        </el-form-item>
      </el-form>
      <p v-if="configState.state !== 'idle'" class="note-ai-config-state-text" :class="formatStateClass(configState)">
        {{ configState.text }}
      </p>
      <template #footer>
        <el-button @click="configVisible = false">取消</el-button>
        <el-button type="primary" @click="saveConfig">保存</el-button>
      </template>
    </el-dialog>
  </el-dialog>
</template>
