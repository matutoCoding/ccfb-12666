// 核心领域类型 —— 全浏览器端计算，无后端

export type ID = string

// ---------- 码头布局 ----------
export interface LayoutParams {
  shorelineLength: number      // 岸线长度 m
  berthCount: number           // 泊位数
  craneCount: number           // 岸桥总数
  craneSpacing: number         // 岸桥间距 m
  blockRows: number            // 堆场箱区数（沿岸线方向的箱区个数）
  blockBays: number            // 每箱区贝位数（列）
  blockTiers: number           // 堆高层数
  laneWidth: number            // 车道宽度 m
  depth: number                // 码头纵深 m
  setback: number              // 岸线到堆场前沿距离 m
  rowWidth: number             // 箱区间通道宽 m
}

export interface LayoutScheme {
  id: ID
  name: string
  params: LayoutParams
  updatedAt: number
}

export interface BerthGeo {
  id: ID
  index: number
  x0: number
  x1: number
  bollards: { id: ID; x: number }[]   // 系船柱沿码头面坐标
}

export interface CraneGeo {
  id: ID
  index: number
  x: number
  berthIndex: number
}

export interface BlockGeo {
  id: ID
  index: number
  x0: number
  z0: number
  bays: number
  rows: number
  tiers: number
  cellW: number
  cellD: number
}

export interface LayoutGeo {
  width: number
  depth: number
  berths: BerthGeo[]
  cranes: CraneGeo[]
  blocks: BlockGeo[]
  roads: RoadLink[]
  laneWidth: number
}

export interface RoadNode { id: ID; x: number; z: number; kind: 'gate' | 'junction' | 'crane' | 'block' }
export interface RoadLink { id: ID; from: ID; to: ID; length: number }
export interface RoadGraph { nodes: RoadNode[]; links: RoadLink[]; adj: Map<ID, { id: ID; to: ID; length: number }[]> }

// ---------- 船型与配载 ----------
export type DGClass = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9   // 0=普通
export type WeightClass = 'L' | 'M' | 'H'                      // 轻/中/重
export type ContainerFlow = 'export' | 'import' | 'transit'
export type ContainerKind = 'normal' | 'reefer' | 'dg' | 'empty'

export interface Container {
  id: ID
  no: string                     // 箱号
  flow: ContainerFlow
  kind: ContainerKind
  dgClass: DGClass
  weight: number                 // 总重 t
  weightClass: WeightClass
  port: string                   // 目的港
  length20: 1 | 2                // 20/40 尺
}

export interface StowCell {
  bay: number
  row: number
  tier: number
  deck: boolean
  reefer: boolean               // 是否冷藏插座位
  containerId: ID | null
}

export interface ShipType {
  id: ID
  name: string
  loa: number                    // 船长 m
  beam: number                   // 型宽 m
  holdTiers: number              // 舱内层数
  deckTiers: number              // 甲板层数
  rows: number                   // 横向排数
  bayCount: number               // 贝位数
  bayRule: string                // 贝位编号规则说明
  bayStart: number               // 起始贝号（奇数）
  reeferSlots: { bay: number; row: number; tier: number }[]
  lightshipKG: number            // 空船重心高 m
  lightshipDisp: number          // 空船排水量 t
  windArea: number               // 水上侧面积 m²（默认按 LOA*型深估算）
  currentArea: number            // 水下侧面积 m²
  gmLimit: number                // 稳性限值（最小 GM）m
  heelLimitDeg: number           // 横倾角限值 °
}

export interface VesselVisit {
  id: ID
  name: string
  shipTypeId: ID
  arrival: number                // 计划靠泊时间戳 h（相对仿真零点的小时数）
  berthId: ID
  departure: number | null
  loadList: ID[]                 // 待装出口/中转箱
  dischargePorts: string[]
  cells: StowCell[]              // 贝位图
  historyFrom?: ID               // 从哪个历史航次整版复制
}

// ---------- 系泊 ----------
export interface MooringLineSpec {
  id: ID
  material: '钢丝' | '高分子缆' | '锦纶' | '丙纶'
  diameter: number               // mm
  mbl: number                    // 破断拉力 kN
  ea: number                     // 轴向刚度 kN
}

export type LineRole = 'head' | 'stern' | 'breast-forward' | 'breast-aft' | 'spring-forward' | 'spring-aft'

export interface MooringLine {
  id: ID
  role: LineRole
  specId: ID
  bollardId: ID                  // 码头系船柱
  shipX: number                  // 船上导缆孔 x（相对船中，m，船首为正）
  angleDeg: number               // 缆绳与码头线夹角（走向）
  tension: number                // kN（计算结果）
  safety: number                 // 安全系数（计算结果）
}

export interface MooringPlan {
  visitId: ID
  windSpeed: number              // m/s 横风
  currentSpeed: number           // m/s 横流
  lines: MooringLine[]
  windForce?: number
  currentForce?: number
}

// ---------- 作业任务 ----------
export interface CraneTask {
  id: ID
  visitId: ID
  bay: number
  moveType: 'load' | 'discharge' | 'hatchcover' | 'twin-lift'
  containerId: ID | null
  craneId: ID
  order: number
  durationH: number
  done: boolean
}

// ---------- 船期/天气 ----------
export interface WeatherPoint { t: number; windSpeed: number; windDirDeg: number; tide: number }

export interface ScheduleItem {
  visitId: ID
  berthId: ID
  start: number                  // h
  end: number | null             // h，完工估算
  warning?: string
}

// ---------- 堆场 ----------
export interface YardSlot {
  blockId: ID
  bay: number
  row: number
  tier: number
  containerId: ID | null
}

// ---------- 仿真 ----------
export type SimEntityKind = 'qc' | 'yc' | 'truck'
export interface SimEntity {
  id: ID
  kind: SimEntityKind
  nodeFrom: ID
  nodeTo: ID
  progress: number               // 0..1
  state: 'idle' | 'moving' | 'working' | 'queueing'
  taskRef?: ID
  x: number
  z: number
}

export interface SimEvent { t: number; text: string; level: 'info' | 'warn' | 'alarm' }

export interface SimState {
  t: number                      // 仿真小时
  running: boolean
  speed: number                  // 倍速
  speedOptions: number[]
  entities: SimEntity[]
  events: SimEvent[]
  queueLengths: Record<ID, number>
}

// ---------- 全局状态 ----------
export interface AppState {
  layouts: LayoutScheme[]
  activeLayoutId: ID
  shipTypes: ShipType[]
  lineLib: MooringLineSpec[]
  vessels: VesselVisit[]
  activeVesselId: ID | null
  containers: Record<ID, Container>
  yard: Record<string, ID | null>     // slotKey -> containerId
  mooring: Record<ID, MooringPlan>    // visitId
  tasks: CraneTask[]
  schedule: ScheduleItem[]
  weather: WeatherPoint[]
  sim: SimState
  reports: ReportBundle | null
}

export interface ReportBundle {
  daily: ReportRow[]
  weekly: ReportRow[]
  generatedAt: number
}

export interface ReportRow {
  period: string
  berthUtil: number               // %
  qcEfficiency: number            // moves/h
  truckWait: number               // min
  rehandleRate: number            // %
  deltas?: Partial<Record<keyof Omit<ReportRow, 'period' | 'deltas'>, number>>
}

export const slotKey = (b: ID, bay: number, row: number, tier: number) =>
  `${b}#${bay}-${row}-${tier}`
