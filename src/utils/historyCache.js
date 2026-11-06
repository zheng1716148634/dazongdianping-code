// 美食AI「生成记录」的浏览器持久缓存（IndexedDB）。
// 图片以 Blob 落库，避开 localStorage 约 5MB 的容量上限，刷新页面后依然能回看。
// 记录结构：{ id, batchId, blob, refBlob, remoteUrl, prompt, promptName,
//             size, quality, model, referenceName, createdAt }

const DB_NAME = 'hero-generations'
const DB_VERSION = 1
const STORE = 'records'

let dbPromise = null

function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('createdAt', 'createdAt')
      }
    }
    request.onsuccess = () => {
      const db = request.result
      // 另一个标签页要升级库时先让路，避免一直 blocked
      db.onversionchange = () => db.close()
      resolve(db)
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('生成记录数据库被其它标签页占用'))
  }).catch((error) => {
    dbPromise = null
    throw error
  })
  return dbPromise
}

function withStore(mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode)
        run(tx.objectStore(STORE))
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
  )
}

export async function loadRecords() {
  const db = await openDb()
  const rows = await new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
    request.onsuccess = () => resolve(request.result || [])
    request.onerror = () => reject(request.error)
  })
  return rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
}

export function putRecords(list) {
  const rows = list.slice()
  return withStore('readwrite', (store) => rows.forEach((row) => store.put(row)))
}

export function deleteRecords(ids) {
  const keys = ids.slice()
  return withStore('readwrite', (store) => keys.forEach((id) => store.delete(id)))
}

export function deleteRecord(id) {
  return deleteRecords([id])
}

export function clearRecords() {
  return withStore('readwrite', (store) => store.clear())
}
