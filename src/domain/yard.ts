import type { AppState, BlockGeo, Container, ID } from '../types'
import { slotKey } from '../types'

export interface BlockStat {
  blockId: ID
  capacity: number
  occupied: number
  occupancy: number          // %
  rehandles: number
  rehandleRate: number       // %
  byFlow: Record<string, number>
}

/** 每个箱区占用率、翻箱率（按"上方压箱即潜在翻箱"统计） */
export function yardStats(state: AppState, blocks: BlockGeo[]): BlockStat[] {
  return blocks.map(b => {
    const capacity = b.bays * b.rows * b.tiers
    let occupied = 0
    let rehandles = 0
    const byFlow: Record<string, number> = { export: 0, import: 0, transit: 0 }
    for (let bay = 0; bay < b.bays; bay++) {
      for (let row = 0; row < b.rows; row++) {
        const stack: string[] = []
        for (let tier = 0; tier < b.tiers; tier++) {
          const id = state.yard[slotKey(b.id, bay, row, tier)]
          if (id) {
            occupied++
            const c = state.containers[id]
            if (c) byFlow[c.flow] = (byFlow[c.flow] ?? 0) + 1
            stack.push(id)
          }
        }
        // 翻箱：栈中任一箱若比其上方某个箱更早被提走（按箱号顺序模拟提箱优先级），则需翻箱
        for (let i = 0; i < stack.length - 1; i++) {
          for (let j = i + 1; j < stack.length; j++) {
            if (pickPriority(state.containers[stack[i]]) > pickPriority(state.containers[stack[j]])) {
              rehandles++
              break
            }
          }
        }
      }
    }
    return {
      blockId: b.id, capacity, occupied,
      occupancy: capacity ? (occupied / capacity) * 100 : 0,
      rehandles,
      rehandleRate: occupied ? (rehandles / occupied) * 100 : 0,
      byFlow
    }
  })
}

function pickPriority(c?: Container): number {
  if (!c) return 999999
  // 出口/中转 > 进口（进口提箱更晚），同类按目的港+箱号稳定排序
  const base = c.flow === 'export' ? 0 : c.flow === 'transit' ? 1 : 2
  return base * 1e8 + hashCode(c.port + c.no)
}

function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

export interface PickStep {
  containerId: ID
  fromSlot: string
  moves: { containerId: ID; from: string; to: string }[]   // 需要先翻走的箱
}

/**
 * 取箱顺序：贪心选择当前可直接取（位于栈顶）且优先级最高的箱；
 * 目标箱被压住时，把上方障碍箱翻到同贝位相邻栈的最低空位，翻箱次数最少。
 */
export function optimalPickSequence(state: AppState, block: BlockGeo, targetIds: ID[]): PickStep[] {
  // 复制堆场状态以便模拟翻箱
  const grid = new Map<string, ID | null>()
  for (const [k, v] of Object.entries(state.yard)) grid.set(k, v)
  const setSlot = (bay: number, row: number, tier: number, id: ID | null) =>
    grid.set(slotKey(block.id, bay, row, tier), id)
  const getSlot = (bay: number, row: number, tier: number) =>
    grid.get(slotKey(block.id, bay, row, tier)) ?? null

  const stackHeight = (bay: number, row: number) => {
    let h = 0
    for (let t = 0; t < block.tiers; t++) if (getSlot(bay, row, t)) h++
    return h
  }
  const findSlotOf = (id: ID) => {
    for (let bay = 0; bay < block.bays; bay++)
      for (let row = 0; row < block.rows; row++)
        for (let tier = 0; tier < block.tiers; tier++)
          if (getSlot(bay, row, tier) === id) return { bay, row, tier }
    return null
  }

  const targets = [...targetIds].sort((a, b) => pickPriority(state.containers[a]) - pickPriority(state.containers[b]))
  const result: PickStep[] = []

  for (const target of targets) {
    const pos = findSlotOf(target)
    if (!pos) continue
    const moves: PickStep['moves'] = []
    // 自上而下搬走障碍箱
    for (let tier = stackHeight(pos.bay, pos.row) - 1; tier > pos.tier; tier--) {
      const blocker = getSlot(pos.bay, pos.row, tier)!
      const dest = findNearestEmpty(block, pos.bay, pos.row, getSlot, stackHeight)
      if (!dest) break
      setSlot(pos.bay, pos.row, tier, null)
      setSlot(dest.bay, dest.row, dest.tier, blocker)
      moves.push({
        containerId: blocker,
        from: slotKey(block.id, pos.bay, pos.row, tier),
        to: slotKey(block.id, dest.bay, dest.row, dest.tier)
      })
    }
    const fromSlot = slotKey(block.id, pos.bay, pos.row, pos.tier)
    setSlot(pos.bay, pos.row, pos.tier, null)
    result.push({ containerId: target, fromSlot, moves })
  }
  return result
}

function findNearestEmpty(
  block: BlockGeo, bay: number, row: number,
  getSlot: (b: number, r: number, t: number) => ID | null,
  stackHeight: (b: number, r: number) => number
) {
  for (let r = 0; r < block.rows; r++) {
    if (r === row) continue
    const h = stackHeight(bay, r)
    if (h < block.tiers && getSlot(bay, r, h) === null) return { bay, row: r, tier: h }
  }
  for (let b2 = Math.max(0, bay - 1); b2 <= Math.min(block.bays - 1, bay + 1); b2++) {
    for (let r = 0; r < block.rows; r++) {
      const h = stackHeight(b2, r)
      if (h < block.tiers) return { bay: b2, row: r, tier: h }
    }
  }
  return null
}

/** 自动落箱：找最低、最平衡的空位 */
export function findDropSlot(state: AppState, block: BlockGeo): string | null {
  let best: { key: string; h: number; occupancy: number } | null = null
  for (let bay = 0; bay < block.bays; bay++) {
    for (let row = 0; row < block.rows; row++) {
      let h = 0
      while (h < block.tiers && state.yard[slotKey(block.id, bay, row, h)]) h++
      if (h >= block.tiers) continue
      const key = slotKey(block.id, bay, row, h)
      if (!best || h < best.h) best = { key, h, occupancy: bay * block.rows + row }
    }
  }
  return best?.key ?? null
}
