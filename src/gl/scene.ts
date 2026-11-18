import type { AppState, LayoutGeo, SimEntity } from '../types'
import { slotKey } from '../types'
import type { InstancedRenderer } from './renderer'

export const COLORS = {
  ground: [0.12, 0.14, 0.16, 1] as const,
  water: [0.05, 0.16, 0.22, 1] as const,
  road: [0.18, 0.19, 0.21, 1] as const,
  blockPad: [0.3, 0.28, 0.24, 1] as const,
  berth: [0.35, 0.33, 0.3, 1] as const,
  crane: [0.95, 0.62, 0.12, 1] as const,
  yc: [0.3, 0.65, 0.9, 1] as const,
  truck: [0.9, 0.9, 0.92, 1] as const,
  gate: [0.55, 0.35, 0.8, 1] as const,
  hull: [0.2, 0.35, 0.55, 1] as const
}

/** 在场箱分色：进出口/中转/冷藏/危险品 */
export function containerColor(state: AppState, id: string): [number, number, number, number] {
  const c = state.containers[id]
  if (!c) return [0.6, 0.6, 0.6, 1]
  if (c.kind === 'reefer') return [0.2, 0.8, 0.75, 1]
  if (c.kind === 'dg') return [0.9, 0.25, 0.2, 1]
  if (c.flow === 'export') return [0.35, 0.62, 0.95, 1]
  if (c.flow === 'import') return [0.55, 0.75, 0.35, 1]
  return [0.95, 0.78, 0.3, 1]   // transit
}

// pickId 分段：0..99999 保留给堆场箱（实例序号映射），100000+ 给设备
export const PICK_ENTITY_BASE = 100000

export interface SceneHandles {
  containerPickMap: Map<number, string>   // pickId -> containerId
  entityPickMap: Map<number, string>      // pickId -> entityId
}

/**
 * 构建静态/半静态场景。每帧调用一次：
 * 地面、泊位、道路、堆场箱（上万实例）、岸桥/场桥/集卡设备。
 */
export function buildScene(
  r: InstancedRenderer,
  state: AppState,
  geo: LayoutGeo,
  entities: SimEntity[] = []
): SceneHandles {
  r.reset()
  const containerPickMap = new Map<number, string>()
  const entityPickMap = new Map<number, string>()

  // 水面 + 陆域
  r.addBox(geo.width / 2, -0.6, -60, geo.width / 2 + 200, 0.5, 60, [...COLORS.water] as never)
  r.addBox(geo.width / 2, -0.5, geo.depth / 2, geo.width / 2, 0.5, geo.depth / 2, [...COLORS.ground] as never)

  // 泊位带
  for (const b of geo.berths) {
    r.addBox((b.x0 + b.x1) / 2, 0.05, 8, (b.x1 - b.x0) / 2 - 1, 0.1, 8, [...COLORS.berth] as never)
    for (const bol of b.bollards) {
      r.addBox(bol.x, 0.4, 2, 0.8, 0.4, 0.8, [0.8, 0.8, 0.75, 1])
    }
  }

  // 道路
  for (const link of geo.roads) {
    // 道路节点在仿真图里；这里用简易条带近似主干道
    void link
  }
  r.addBox(geo.width / 2, 0.02, geo.laneWidth * 1.2, geo.width / 2, 0.08, geo.laneWidth / 2, [...COLORS.road] as never)
  r.addBox(geo.width / 2, 0.02, geo.depth - geo.laneWidth * 1.5, geo.width / 2, 0.08, geo.laneWidth / 2, [...COLORS.road] as never)

  // 堆场箱区 + 在场箱（实例化）
  let pickSeq = 0
  for (const blk of geo.blocks) {
    const w = blk.rows * blk.cellW
    const d = blk.bays * blk.cellD
    const cx = blk.x0 + w / 2
    const cz = blk.z0 + d / 2
    r.addBox(cx, 0.05, cz, w / 2 + 1, 0.1, d / 2 + 1, [...COLORS.blockPad] as never)
    for (let bay = 0; bay < blk.bays; bay++) {
      for (let row = 0; row < blk.rows; row++) {
        for (let tier = 0; tier < blk.tiers; tier++) {
          const cid = state.yard[slotKey(blk.id, bay, row, tier)]
          if (!cid) continue
          const x = blk.x0 + row * blk.cellW + blk.cellW / 2
          const z = blk.z0 + bay * blk.cellD + blk.cellD / 2
          const y = 1.4 + tier * 2.7
          const pid = pickSeq++
          containerPickMap.set(pid, cid)
          r.addBox(x, y, z, 2.9, 1.28, 1.18, containerColor(state, cid), pid)
        }
      }
    }
  }

  // 岸桥（简化模型：门腿 + 大梁 + 小车）
  geo.cranes.forEach((c, i) => {
    const pid = PICK_ENTITY_BASE + i
    entityPickMap.set(pid, c.id)
    const col = [...COLORS.crane] as [number, number, number, number]
    r.addBox(c.x, 18, 14, 1.2, 18, 1.2, col, pid)
    r.addBox(c.x, 18, 26, 1.2, 18, 1.2, col, pid)
    r.addBox(c.x, 36, 8, 1.6, 1.4, 22, col, pid)
    r.addBox(c.x, 33, -8, 1.4, 1.2, 10, [0.8, 0.5, 0.1, 1], pid)
  })

  // 仿真实体：场桥 + 集卡（位置由引擎实时驱动）
  entities.forEach((e, i) => {
    const pid = PICK_ENTITY_BASE + 200 + i
    entityPickMap.set(pid, e.id)
    if (e.kind === 'yc') {
      r.addBox(e.x, 8, e.z, 5, 8, 4, [...COLORS.yc] as never, pid)
      r.addBox(e.x, 16, e.z, 7, 1, 5, [...COLORS.yc] as never, pid)
    } else if (e.kind === 'truck') {
      const working = e.state === 'working' || e.state === 'queueing'
      r.addBox(e.x, 1.2, e.z, 3.2, 1.1, 1.3, working ? [1, 0.6, 0.2, 1] : [...COLORS.truck] as never, pid)
      r.addBox(e.x, 2.2, e.z - 2, 1.4, 1, 1.3, [0.3, 0.35, 0.45, 1], pid)
    }
  })

  // 闸口
  const gateNode = { x: geo.width / 2, z: geo.depth - geo.laneWidth }
  r.addBox(gateNode.x, 4, gateNode.z, 12, 4, 1.5, [...COLORS.gate] as never)

  return { containerPickMap, entityPickMap }
}
