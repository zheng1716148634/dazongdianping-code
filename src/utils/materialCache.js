// 点评素材的浏览器持久缓存（IndexedDB）。
// 每条笔记存：{ id, url, title, content, images: [{ url, blob }], fetchedAt }
// 图片以 Blob 落库，刷新页面后依然在；同时在支持的环境申请持久化存储，降低被自动清理的概率。

const DB_NAME = 'dianping-materials'
const DB_VERSION = 1
const STORE = 'notes'

let dbPromise = null

function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return dbPromise
}

function withStore(mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode)
        const request = run(tx.objectStore(STORE))
        tx.oncomplete = () => resolve(request instanceof IDBRequest ? request.result : undefined)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
  )
}

function getAll(db) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
    request.onsuccess = () => resolve(request.result || [])
    request.onerror = () => reject(request.error)
  })
}

export async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persist) {
      const already = await navigator.storage.persisted?.()
      if (already) return true
      return await navigator.storage.persist()
    }
  } catch {
    /* 忽略：不支持就按普通缓存对待 */
  }
  return false
}

export async function loadNotes() {
  const db = await openDb()
  const notes = await getAll(db)
  return notes.sort((a, b) => b.fetchedAt - a.fetchedAt)
}

export async function saveNote(note) {
  await withStore('readwrite', (store) => store.put(note))
}

export async function removeNote(id) {
  await withStore('readwrite', (store) => store.delete(id))
}

export async function clearNotes() {
  await withStore('readwrite', (store) => store.clear())
}
