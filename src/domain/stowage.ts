import type { Container, ShipType, StowCell, VesselVisit, WeightClass, DGClass } from '../types'
import { uid } from '../state/store'

/** 由船型生成贝位图骨架 */
export function buildCells(ship: ShipType): StowCell[] {
  const cells: StowCell[] = []
  const reeferSet = new Set(ship.reeferSlots.map(r => `${r.bay}-${r.row}-${r.tier}`))
  for (let b = 0; b < ship.bayCount; b++) {
    const bayNo = ship.bayStart + b * 2
    for (let r = 0; r < ship.rows; r++) {
      for (let t = 0; t < ship.holdTiers + ship.deckTiers; t++) {
        const deck = t >= ship.holdTiers
        const tierNo = deck ? t - ship.holdTiers + 82 : t + 2   // 舱内 02/04…，甲板 82/84…
        cells.push({
          bay: bayNo,
          row: r < ship.rows / 2 ? -(Math.ceil((ship.rows / 2 - r))) : r - ship.rows / 2 + 1,
          tier: tierNo,
          deck,
          reefer: reeferSet.has(`${bayNo}-${r < ship.rows / 2 ? -(Math.ceil((ship.rows / 2 - r))) : r - ship.rows / 2 + 1}-${tierNo}`),
          containerId: null
        })
      }
    }
  }
  return cells
}

/** 危品隔离：1/7 类隔离两个箱位，3/4/5 类不同贝，其余不同列即可 */
function dgConflict(a: DGClass, b: DGClass, cells: StowCell[], ca: StowCell, cb: StowCell): boolean {
  if (a === 0 || b === 0) return false
  if (a === 1 || b === 1 || a === 7 || b === 7) {
    const dist = Math.abs(ca.bay - cb.bay) + Math.abs(ca.row - cb.row) + Math.abs(ca.tier - cb.tier)
    return dist < 2
  }
  if ([3, 4, 5].includes(a) || [3, 4, 5].includes(b)) return ca.bay === cb.bay
  return ca.bay === cb.bay && ca.row === cb.row
}

const weightRank: Record<WeightClass, number> = { H: 0, M: 1, L: 2 }

export interface AutoPlanResult {
  cells: StowCell[]
  unassigned: Container[]
  violations: string[]
}

/**
 * 自动排船图：
 * - 后卸港（dischargePorts 中靠后）压上层
 * - 重箱在下、轻箱在上
 * - 冷藏箱进插座，危品按隔离规则
 * - 左右舷对称布置以控制横倾
 */
export function autoStow(ship: ShipType, visit: VesselVisit, containers: Record<string, Container>): AutoPlanResult {
  const cells = visit.cells.length ? visit.cells.map(c => ({ ...c, containerId: null })) : buildCells(ship)
  const violations: string[] = []
  const load = visit.loadList.map(id => containers[id]).filter(Boolean)
  const portRank = new Map(visit.dischargePorts.map((p, i) => [p, i]))

  const sorted = [...load].sort((a, b) => {
    // 危险品与冷藏先安排（约束多）
    const score = (c: Container) => (c.kind === 'dg' ? 0 : c.kind === 'reefer' ? 1 : 2)
    if (score(a) !== score(b)) return score(a) - score(b)
    const pa = portRank.get(a.port) ?? 99
    const pb = portRank.get(b.port) ?? 99
    if (pa !== pb) return pa - pb                       // 先卸港在底
    return weightRank[a.weightClass] - weightRank[b.weightClass]  // 重箱在底
  })

  const unassigned: Container[] = []
  const occupied: StowCell[] = []

  for (const c of sorted) {
    const candidates = cells.filter(cell => {
      if (cell.containerId) return false
      if (c.kind === 'reefer' && !cell.reefer) return false
      if (cell.deck && hasEmptyBelow(cells, cell)) return false
      if (!cell.deck && hasEmptyBelow(cells, cell)) return false
      if (c.kind === 'dg') {
        for (const occ of occupied) {
          const other = containers[occ.containerId!]
          if (other?.kind === 'dg' && dgConflict(c.dgClass, other.dgClass, cells, cell, occ)) return false
        }
      }
      return true
    })
    if (!candidates.length) { unassigned.push(c); continue }
    // 选位：优先匹配港口层带 + 左右舷交替保持对称
    candidates.sort((a, b) => {
      const pa = portRank.get(c.port) ?? 99
      const sideA = Math.abs(a.row) + (a.row > 0 ? 0.3 : 0)
      const sideB = Math.abs(b.row) + (b.row > 0 ? 0.3 : 0)
      return (a.deck ? 10 : 0) - (b.deck ? 10 : 0) || pa - (portRank.get(c.port) ?? 99) || sideA - sideB || a.tier - b.tier
    })
    const pick = candidates[0]
    pick.containerId = c.id
    occupied.push(pick)
  }

  const stab = computeStability(ship, cells, containers)
  if (stab.gm < ship.gmLimit) violations.push(`初稳性高 GM=${stab.gm.toFixed(2)}m 低于限值 ${ship.gmLimit}m`)
  if (Math.abs(stab.heelDeg) > ship.heelLimitDeg) violations.push(`横倾角 ${stab.heelDeg.toFixed(2)}° 超过限值 ${ship.heelLimitDeg}°`)
  if (unassigned.length) violations.push(`${unassigned.length} 个箱无法安排（舱位或隔离约束不足）`)
  return { cells, unassigned, violations }
}

function hasEmptyBelow(cells: StowCell[], cell: StowCell): boolean {
  if (cell.tier <= (cell.deck ? 82 : 2)) return false
  const belowTier = cell.tier - 2
  return !cells.some(c => c.bay === cell.bay && c.row === cell.row && c.tier === belowTier && c.containerId)
}

export interface Stability {
  gm: number
  heelDeg: number
  kg: number
  totalWeight: number
  lcg: number
}

/** 重心高度、横向重心、初稳性高 GM 与横倾角（实时计算，拖换箱后立即调用） */
export function computeStability(ship: ShipType, cells: StowCell[], containers: Record<string, Container>): Stability {
  let totalW = ship.lightshipDisp
  let momZ = ship.lightshipDisp * ship.lightshipKG
  let momY = 0
  const rowStep = 2.45
  const tierStep = 2.6
  const holdBaseZ = 6
  const deckBaseZ = holdBaseZ + ship.holdTiers * tierStep + 1.6
  for (const c of cells) {
    if (!c.containerId) continue
    const ct = containers[c.containerId]
    if (!ct) continue
    const z = c.deck ? deckBaseZ + (c.tier - 82) * tierStep : holdBaseZ + (c.tier - 2) * tierStep
    const y = c.row * rowStep
    totalW += ct.weight
    momZ += ct.weight * z
    momY += ct.weight * y
  }
  const kg = momZ / totalW
  const tcg = momY / totalW
  // 横稳心半径 BM = I/V：I 为水线面横向惯性矩，按矩形水线面 B³L/12 估算；
  // V 为排水体积（海水密度 1.025 t/m³）。KM = KB + BM，取 KB ≈ 0.53·吃水，吃水按排水量近似。
  const rho = 1.025
  const displacedVol = totalW / rho
  const draft = displacedVol / (ship.beam * ship.loa * 0.85)
  const kb = 0.53 * draft
  const iWaterplane = (ship.loa * 0.92 * Math.pow(ship.beam, 3)) / 12
  const bm = iWaterplane / Math.max(1, displacedVol)
  const km = kb + bm
  const gm = km - kg
  const heelDeg = (Math.atan(tcg / Math.max(0.3, gm)) * 180) / Math.PI
  return { gm, heelDeg, kg, totalWeight: totalW, lcg: tcg }
}

/** 整版复制历史航次配载（按箱位结构克隆，箱号重新生成由调用方决定） */
export function cloneCells(src: StowCell[]): StowCell[] {
  return src.map(c => ({ ...c }))
}

export function makeVisit(ship: ShipType, name: string, arrival: number, berthId: string): VesselVisit {
  return {
    id: uid('vis'),
    name,
    shipTypeId: ship.id,
    arrival,
    berthId,
    departure: null,
    loadList: [],
    dischargePorts: ['上海', '宁波', '深圳'],
    cells: buildCells(ship)
  }
}
