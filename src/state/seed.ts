import type {
  AppState, Container, ContainerFlow, ContainerKind, DGClass, LayoutScheme,
  MooringLineSpec, ShipType, StowCell, VesselVisit, WeatherPoint, WeightClass
} from '../types'
import { slotKey } from '../types'
import { uid } from './store'
import { buildCells } from '../domain/stowage'
import { buildGeo } from '../domain/layout'
import { decomposeTasks } from '../domain/operations'

const PORTS = ['上海', '宁波', '深圳', '新加坡', '鹿特丹']

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const LAYOUT_PRESETS: { name: string; p: AppState['layouts'][number]['params'] }[] = [
  { name: '方案A 紧凑型 4泊位', p: { shorelineLength: 1200, berthCount: 4, craneCount: 12, craneSpacing: 90, blockRows: 8, blockBays: 20, blockTiers: 5, laneWidth: 8, depth: 600, setback: 40, rowWidth: 6 } },
  { name: '方案B 疏朗型 3泊位', p: { shorelineLength: 1050, berthCount: 3, craneCount: 9, craneSpacing: 110, blockRows: 6, blockBays: 24, blockTiers: 6, laneWidth: 10, depth: 650, setback: 50, rowWidth: 8 } },
  { name: '方案C 自动化 5泊位', p: { shorelineLength: 1500, berthCount: 5, craneCount: 18, craneSpacing: 80, blockRows: 10, blockBays: 18, blockTiers: 6, laneWidth: 7, depth: 700, setback: 45, rowWidth: 5 } }
]

const SHIP_PRESETS: Omit<ShipType, 'id'>[] = [
  { name: '支线船 1000TEU', loa: 145, beam: 23, holdTiers: 4, deckTiers: 3, rows: 8, bayCount: 12, bayRule: '奇数贝号，首贝01，步长2', bayStart: 1, reeferSlots: [], lightshipKG: 7.2, lightshipDisp: 4800, windArea: 2600, currentArea: 1800, gmLimit: 0.3, heelLimitDeg: 12 },
  { name: '巴拿马型 4500TEU', loa: 260, beam: 32, holdTiers: 6, deckTiers: 5, rows: 12, bayCount: 18, bayRule: '奇数贝号，首贝03，步长2', bayStart: 3, reeferSlots: [], lightshipKG: 10.5, lightshipDisp: 14500, windArea: 5200, currentArea: 3600, gmLimit: 0.5, heelLimitDeg: 10 },
  { name: '超巴拿马 10000TEU', loa: 335, beam: 43, holdTiers: 7, deckTiers: 6, rows: 16, bayCount: 22, bayRule: '奇数贝号，首贝01，步长2', bayStart: 1, reeferSlots: [], lightshipKG: 13.1, lightshipDisp: 28000, windArea: 8200, currentArea: 5200, gmLimit: 0.6, heelLimitDeg: 8 }
]

const LINE_PRESETS: Omit<MooringLineSpec, 'id'>[] = [
  { material: '钢丝', diameter: 32, mbl: 780, ea: 42000 },
  { material: '钢丝', diameter: 40, mbl: 1180, ea: 56000 },
  { material: '高分子缆', diameter: 36, mbl: 1320, ea: 38000 },
  { material: '高分子缆', diameter: 44, mbl: 1900, ea: 52000 },
  { material: '锦纶', diameter: 48, mbl: 980, ea: 12000 },
  { material: '丙纶', diameter: 40, mbl: 760, ea: 9000 }
]

export function seedState(): AppState {
  const r = rng(20261119)
  const now = Date.now()

  const layouts: LayoutScheme[] = LAYOUT_PRESETS.map((s, i) => ({
    id: `layout_${i}`, name: s.name, params: s.p, updatedAt: now
  }))
  const geo = buildGeo(layouts[0].params)

  const shipTypes: ShipType[] = SHIP_PRESETS.map((s, i) => {
    const st: ShipType = { ...s, id: `ship_${i}`, reeferSlots: [] }
    // 甲板外侧列布置冷藏插座
    for (let b = 0; b < st.bayCount; b += 2) {
      const bayNo = st.bayStart + b * 2
      const edgeRow = st.rows / 2
      for (let t = 0; t < Math.min(3, st.deckTiers); t++) {
        st.reeferSlots.push({ bay: bayNo, row: edgeRow, tier: 82 + t * 2 })
      }
    }
    return st
  })

  const lineLib: MooringLineSpec[] = LINE_PRESETS.map(l => ({ ...l, id: uid('ls') }))

  // ---- 1.2 万集装箱池 ----
  const containers: Record<string, Container> = {}
  const allIds: string[] = []
  const flows: ContainerFlow[] = ['export', 'import', 'transit']
  const wcs: WeightClass[] = ['L', 'M', 'H']
  const TOTAL = 12000
  for (let i = 0; i < TOTAL; i++) {
    const roll = r()
    const kind: ContainerKind = roll < 0.06 ? 'reefer' : roll < 0.1 ? 'dg' : roll < 0.16 ? 'empty' : 'normal'
    const dg: DGClass = kind === 'dg' ? ([1, 2, 3, 4, 5, 6, 8, 9][Math.floor(r() * 8)] as DGClass) : 0
    const wc: WeightClass = kind === 'empty' ? 'L' : wcs[Math.floor(r() * 3)]
    const weight = kind === 'empty' ? 2.2 : wc === 'L' ? 8 + r() * 6 : wc === 'M' ? 16 + r() * 6 : 24 + r() * 6
    const id = `ct_${i}`
    containers[id] = {
      id,
      no: `CSNU${String(1000000 + i).slice(-7)}${(i * 7) % 10}`,
      flow: flows[Math.floor(r() * 3)],
      kind,
      dgClass: dg,
      weight: +weight.toFixed(1),
      weightClass: wc,
      port: PORTS[Math.floor(r() * PORTS.length)],
      length20: r() < 0.85 ? 1 : 2
    }
    allIds.push(id)
  }

  // ---- 船舶航次（4 条船，覆盖 5 天）----
  const vessels: VesselVisit[] = []
  let poolCursor = 0
  const visitNames = ['远东星', '南洋号', '东方天际', '海运先锋']
  shipTypes.forEach((st, i) => {
    const berth = geo.berths[i % geo.berths.length]
    const cells = buildCells(st)
    const fillCount = Math.min(cells.length * 0.7, 420 + i * 120)
    const loadList: string[] = []
    let filled = 0
    for (const cell of cells) {
      if (filled >= fillCount) break
      const cid = allIds[poolCursor++ % allIds.length]
      const c = containers[cid]
      if (c.kind === 'reefer' && !cell.reefer) continue
      cell.containerId = cid
      loadList.push(cid)
      filled++
    }
    vessels.push({
      id: uid('vis'),
      name: visitNames[i],
      shipTypeId: st.id,
      arrival: 8 + i * 22,
      berthId: berth.id,
      departure: null,
      loadList,
      dischargePorts: [...PORTS],
      cells
    })
  })

  // ---- 堆场填充（约 60%）----
  const yard: Record<string, string | null> = {}
  for (const blk of geo.blocks) {
    for (let bay = 0; bay < blk.bays; bay++) {
      for (let row = 0; row < blk.rows; row++) {
        const stackH = Math.floor(r() * (blk.tiers + 1))   // 0~tiers，均值约一半多
        for (let tier = 0; tier < stackH; tier++) {
          const cid = allIds[poolCursor++ % allIds.length]
          yard[slotKey(blk.id, bay, row, tier)] = cid
        }
      }
    }
  }

  // ---- 任务拆分 ----
  const tasks = vessels.flatMap(v => decomposeTasks(v, geo))

  // ---- 7 天逐时气象，含一个大风窗口 ----
  const weather: WeatherPoint[] = []
  for (let t = 0; t < 24 * 7; t++) {
    const storm = t >= 46 && t <= 58
    const windSpeed = storm ? 16 + r() * 5 : 5 + r() * 8
    weather.push({
      t,
      windSpeed: +windSpeed.toFixed(1),
      windDirDeg: Math.floor(r() * 360),
      tide: +(2.5 + 1.8 * Math.sin((t / 12.4) * Math.PI)).toFixed(2)
    })
  }

  return {
    layouts,
    activeLayoutId: layouts[0].id,
    shipTypes,
    lineLib,
    vessels,
    activeVesselId: vessels[0].id,
    containers,
    yard,
    mooring: {},
    tasks,
    schedule: [],
    weather,
    sim: {
      t: 0,
      running: false,
      speed: 8,
      speedOptions: [1, 2, 4, 8, 16, 32, 64],
      entities: [],
      events: [],
      queueLengths: {}
    },
    reports: null
  }
}
