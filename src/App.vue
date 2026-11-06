<script setup>
import { computed, onMounted, ref } from 'vue'
import { Brush, Check } from '@element-plus/icons-vue'
import ReflectionStudio from './components/ReflectionStudio.vue'
import LinkExtractor from './components/LinkExtractor.vue'
import CollageStudio from './components/CollageStudio.vue'
import PairStudio from './components/PairStudio.vue'
import HeroImageStudio from './components/HeroImageStudio.vue'
import { initMaterials } from './stores/materials'
import { busy, pendingJobs } from './stores/heroHistory'
import { THEMES, savedTheme, setTheme } from './utils/theme'

const PAGES = [
  { key: 'links', title: '素材提取', component: LinkExtractor, hash: '#/links' },
  { key: 'hero', title: '美食AI', component: HeroImageStudio, hash: '#/hero' },
  { key: 'collage', title: '单图拼接', component: CollageStudio, hash: '#/collage' },
  { key: 'pair', title: '批量拼接', component: PairStudio, hash: '#/pair' },
  { key: 'reflect', title: '倒影合成', component: ReflectionStudio, hash: '#/reflect' },
]

function pageFromHash() {
  return PAGES.find((page) => page.hash === window.location.hash) || PAGES[0]
}

const currentKey = ref(pageFromHash().key)
const currentPage = computed(() => PAGES.find((page) => page.key === currentKey.value))

function go(page) {
  currentKey.value = page.key
  if (window.location.hash !== page.hash) {
    window.location.hash = page.hash
  }
}

function onHashChange() {
  currentKey.value = pageFromHash().key
  window.scrollTo({ top: 0 })
}

// ---------- 四季主题（全局顶栏右上角） ----------

const theme = ref(savedTheme())

function pickTheme(key) {
  theme.value = key
  setTheme(key)
}

onMounted(() => {
  window.addEventListener('hashchange', onHashChange)
  // 首次进入把默认 hash 补齐，方便直接复制某个工具的地址
  if (!window.location.hash) window.location.hash = PAGES[0].hash
  // 启动即载入全局素材库，任意页面打开素材选择器都有数据
  initMaterials().catch(() => {})
})
</script>

<template>
  <main class="studio">
    <nav class="tabs" aria-label="工具切换">
      <img class="mark" src="/logo-mark.png" alt="观光集" />
      <div class="tab-row">
        <button
          v-for="page in PAGES"
          :key="page.key"
          type="button"
          class="tab"
          :class="{ 'is-active': page.key === currentKey }"
          :aria-current="page.key === currentKey ? 'page' : undefined"
          @click="go(page)"
        >
          {{ page.title }}
        </button>
      </div>

      <div class="tabs-tools">
        <button
          v-if="busy"
          type="button"
          class="job-badge"
          :title="`有 ${pendingJobs.length} 个配图任务在后台生成，点此回到美食配图`"
          @click="go(PAGES[1])"
        >
          <span class="job-spinner" aria-hidden="true"></span>
          配图生成中
        </button>
        <el-popover placement="bottom-end" :width="248" trigger="click">
          <template #reference>
            <el-button size="small" title="切换四季主题">
              <el-icon class="btn-icon"><Brush /></el-icon>
              主题
            </el-button>
          </template>
          <div class="theme-picker">
            <p class="theme-picker-title">换一套四季配色</p>
            <div class="theme-options">
              <button
                v-for="t in THEMES"
                :key="t.key"
                type="button"
                class="theme-option"
                :class="{ 'is-active': theme === t.key }"
                @click="pickTheme(t.key)"
              >
                <span
                  class="theme-swatch"
                  :style="{ background: `linear-gradient(135deg, ${t.swatch2} 58%, ${t.swatch} 58%)` }"
                  aria-hidden="true"
                />
                <span class="theme-name">{{ t.label }}<small>{{ t.desc }}</small></span>
                <el-icon v-if="theme === t.key" class="theme-check"><Check /></el-icon>
              </button>
            </div>
          </div>
        </el-popover>
      </div>
    </nav>

    <!-- 缓存各工作台实例：切换选项卡不再销毁组件，页面状态就地保留 -->
    <Transition name="page" mode="out-in">
      <KeepAlive>
        <component :is="currentPage.component" :key="currentKey" />
      </KeepAlive>
    </Transition>
  </main>
</template>
