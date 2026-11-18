import type { AppState, CraneTask, LayoutGeo, ScheduleItem, VesselVisit } from '../types'
import { uid } from '../state/store'

export const QC_CYCLE_H = 1.6 / 60        // 单箱循环 1.6 分钟
export const TWIN_CYCLE_H = 2.2 / 60     // 双箱吊循环
export const HATCH_CYCLE_H = 3 / 60      // 舱盖板暂存
export const TRUCK_SPEED = 20000         // m/h ≈ 20km/h

/** 按贝位拆任务：每个有箱动作的贝位生成装卸任务序列，均分给该泊位的岸桥 */
export function decomposeTasks(visit: VesselVisit, geo: LayoutGeo): CraneTask[] {
  const tasks: CraneTask[] = []
  const qcs = geo.cranes.filter(c => c.berthIndex === geo.berths.findIndex(b => b.id === visit.berthId))
  if (!qcs.length) return tasks
  const bays = [...new Set(visit.cells.filter(c => c.containerId).map(c => c.bay))].sort((a, b) => a - b)
  let order = 0
  bays.forEach((bay, bi) => {
    const cells = visit.cells.filter(c => c.bay === bay && c.containerId)
    // 每 2 个相邻箱合并一个双箱吊任务（演示双箱工艺）
    let i = 0
    while (i < cells.length) {
      const twin = i + 1 < cells.length && cells[i].deck === cells[i + 1].deck
      tasks.push({
        id: uid('tk'),
        visitId: visit.id,
        bay,
        moveType: twin ? 'twin-lift' : 'load',
        containerId: cells[i].containerId,
        craneId: qcs[bi % qcs.length].id,
        order: order++,
        durationH: twin ? TWIN_CYCLE_H : QC_CYCLE_H,
        done: false
      })
      if (twin) i += 2
      else i += 1
    }
    // 舱内贝位加一个舱盖板暂存任务
    if (cells.some(c => !c.deck)) {
      tasks.push({
        id: uid('tk'), visitId: visit.id, bay, moveType: 'hatchcover', containerId: null,
        craneId: qcs[bi % qcs.length].id, order: order++, durationH: HATCH_CYCLE_H, done: false
      })
    }
  })
  return balanceTasks(tasks, qcs.map(q => q.id))
}

/** 任务在岸桥间拖动重分后，按岸桥负载均衡重新排序 */
export function balanceTasks(tasks: CraneTask[], craneIds: string[]): CraneTask[] {
  if (!craneIds.length) return tasks
  const loads = new Map(craneIds.map(id => [id, 0]))
  return tasks.map((t, i) => {
    const craneId = t.craneId && craneIds.includes(t.craneId)
      ? t.craneId
      : [...loads.entries()].sort((a, b) => a[1] - b[1])[0][0]
    loads.set(craneId, (loads.get(craneId) ?? 0) + t.durationH)
    return { ...t, craneId, order: i }
  })
}

export interface CraneLoad { craneId: string; tasks: number; hours: number }

/** 单桥效率与整船预计完工时间 —— 任何拖动/配载改动后立即重算 */
export function estimateVisit(visit: VesselVisit, tasks: CraneTask[]): {
  loads: CraneLoad[]
  makespanH: number
  qcRate: number
  moves: number
} {
  const mine = tasks.filter(t => t.visitId === visit.id)
  const byCrane = new Map<string, CraneLoad>()
  for (const t of mine) {
    const cur = byCrane.get(t.craneId) ?? { craneId: t.craneId, tasks: 0, hours: 0 }
    cur.tasks += 1
    cur.hours += t.durationH
    byCrane.set(t.craneId, cur)
  }
  const loads = [...byCrane.values()]
  const makespanH = Math.max(0, ...loads.map(l => l.hours))
  const moves = mine.reduce((s, t) => s + (t.moveType === 'twin-lift' ? 2 : 1), 0)
  const qcRate = makespanH > 0 && loads.length ? moves / makespanH / loads.length : 0
  return { loads, makespanH, qcRate, moves }
}

/** 船期重排 + 气象预警 + 泊位利用率，全量 O(n log n) 重算，保证改一处即刻一致 */
export function recomputeSchedule(state: AppState, geo: LayoutGeo): ScheduleItem[] {
  const WIND_LIMIT = 15 // m/s，靠离泊风速上限
  const items: ScheduleItem[] = []
  const visits = [...state.vessels].sort((a, b) => a.arrival - b.arrival)
  const berthFree = new Map<string, number>(geo.berths.map(b => [b.id, 0]))

  for (const v of visits) {
    const est = estimateVisit(v, state.tasks.filter(t => t.visitId === v.id))
    const start = Math.max(v.arrival, berthFree.get(v.berthId) ?? 0)
    const end = start + est.makespanH
    berthFree.set(v.berthId, end)
    const wp = state.weather.find(w => Math.abs(w.t - start) < 3)
    let warning: string | undefined
    if (wp && wp.windSpeed > WIND_LIMIT) {
      const shift = state.weather.find(w => w.t > start && w.windSpeed <= WIND_LIMIT)
      warning = `靠泊时段风速 ${wp.windSpeed.toFixed(1)}m/s 超上限 ${WIND_LIMIT}m/s` +
        (shift ? `，建议推迟至 t=${shift.t.toFixed(0)}h` : '，建议调整船期')
    }
    items.push({ visitId: v.id, berthId: v.berthId, start, end, warning })
  }
  return items
}

/** 泊位利用率：周期内占用时长 / (泊位数 × 周期时长) */
export function berthUtilization(schedule: ScheduleItem[], berthCount: number, horizonH: number): number {
  const busy = schedule.reduce((s, i) => s + Math.max(0, (i.end ?? i.start) - i.start), 0)
  return horizonH > 0 ? (busy / (berthCount * horizonH)) * 100 : 0
}

export function reassignTask(tasks: CraneTask[], taskId: string, craneId: string): CraneTask[] {
  return balanceTasks(tasks.map(t => t.id === taskId ? { ...t, craneId } : t),
    [...new Set(tasks.map(t => t.craneId))])
}
