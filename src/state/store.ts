import type { AppState } from '../types'
import { seedState } from './seed'

const LS_KEY = 'terminal-sim-state-v1'
const IDB_KEY = 'state'
const IDB_STORE = 'kv'
const IDB_NAME = 'terminal-sim-db'

let idb: IDBDatabase | null = null

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (idb) return resolve(idb)
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
    req.onsuccess = () => { idb = req.result; resolve(idb) }
    req.onerror = () => reject(req.error)
  })
}

async function idbPut(value: AppState) {
  try {
    const db = await openIdb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite')
      tx.objectStore(IDB_STORE).put(value, IDB_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (e) {
    console.warn('IndexedDB 持久化失败', e)
  }
}

function idbGet(): Promise<AppState | null> {
  return openIdb().then(db => new Promise<AppState | null>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly')
    const req = tx.objectStore(IDB_STORE).get(IDB_KEY)
    req.onsuccess = () => resolve((req.result as AppState | null) ?? null)
    req.onerror = () => reject(req.error)
  })).catch(() => null)
}

/** 启动时按优先级恢复：IndexedDB → localStorage → 演示种子数据 */
export async function loadInitialState(): Promise<AppState> {
  try {
    const fromIdb = await idbGet()
    if (fromIdb) return fromIdb
    const raw = localStorage.getItem(LS_KEY)
    if (raw) return JSON.parse(raw) as AppState
  } catch (e) {
    console.warn('状态读取失败，使用初始数据', e)
  }
  return seedState()
}

let state: AppState = seedState()
const listeners = new Set<() => void>()
let saveTimer = 0
let idbFallback = false

function persist() {
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    const json = JSON.stringify(state)
    if (!idbFallback) {
      try {
        localStorage.setItem(LS_KEY, json)
        return
      } catch {
        idbFallback = true
        console.warn('localStorage 配额不足，自动切换 IndexedDB 持久化')
      }
    }
    void idbPut(state)
  }, 250)
}

export function getState(): AppState { return state }

export function setState(mutator: (draft: AppState) => void): AppState {
  mutator(state)
  persist()
  listeners.forEach(l => l())
  return state
}

/** 只改数据不发通知（渲染过程中补齐派生数据时用，避免重入） */
export function silentSet(mutator: (draft: AppState) => void) {
  mutator(state)
  persist()
}

export function replaceState(next: AppState) {
  state = next
  idbFallback = false
  persist()
  listeners.forEach(l => l())
}

export function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

export function resetState() {
  replaceState(seedState())
}

export function exportState(): string {
  return JSON.stringify(state, null, 2)
}

export function uid(prefix = 'id'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`
}
