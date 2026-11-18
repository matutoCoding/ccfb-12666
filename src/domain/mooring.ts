import type { BerthGeo, MooringLine, MooringLineSpec, MooringPlan, ShipType } from '../types'
import { uid } from '../state/store'

const RHO_AIR = 1.225
const RHO_WATER = 1025
const C_WIND = 1.12
const C_CURRENT = 1.2

/** 六级横风（13.8 m/s 取中值）与 0.8 m/s 横流的环境力，均取横向（y 向）+ 少量纵向分量 */
export function envForces(ship: ShipType, windSpeed: number, currentSpeed: number) {
  const windForce = 0.5 * RHO_AIR * C_WIND * windSpeed * windSpeed * ship.windArea / 1000   // kN
  const currentForce = 0.5 * RHO_WATER * C_CURRENT * currentSpeed * currentSpeed * ship.currentArea / 1000
  return { windForce, currentForce }
}

/**
 * 按船长与系船柱排布自动配头缆/尾缆/横缆/倒缆：
 * 头部、尾部各 2 根头/尾缆 + 1 横缆 + 1 倒缆，共 8 根起步。
 */
export function defaultLines(ship: ShipType, berth: BerthGeo, specId: string): MooringLine[] {
  const half = ship.loa / 2
  const b = berth.bollards
  const pick = (k: number) => b[Math.max(0, Math.min(b.length - 1, k))].id
  const mk = (role: MooringLine['role'], shipX: number, bollardId: string, angleDeg: number): MooringLine => ({
    id: uid('ln'), role, specId, bollardId, shipX, angleDeg, tension: 0, safety: 0
  })
  return [
    mk('head', half * 0.85, pick(b.length - 1), 35),
    mk('head', half * 0.7, pick(b.length - 2), 25),
    mk('breast-forward', half * 0.45, pick(b.length - 2), 80),
    mk('spring-forward', half * 0.55, pick(b.length - 3), -15),
    mk('spring-aft', -half * 0.55, pick(2), 15),
    mk('breast-aft', -half * 0.45, pick(1), 80),
    mk('stern', -half * 0.7, pick(1), -25),
    mk('stern', -half * 0.85, pick(0), -35)
  ]
}

/**
 * 缆绳张力求解：3 自由度（纵移 x、横移 y、艏摇 ψ）线性弹性系泊。
 * 环境力 → 位移 → 逐根应变 → 张力与安全系数。
 * 方向余弦由导缆孔→系船柱的实际几何确定（恒为拉向码头），
 * 叠加预张力保证各缆均有承载，工作张力取非负。
 */
export function solveMooring(ship: ShipType, plan: MooringPlan, specs: Map<string, MooringLineSpec>, bollardX: Map<string, number>, berthMidX: number): MooringPlan {
  const { windForce, currentForce } = envForces(ship, plan.windSpeed, plan.currentSpeed)
  const Fext = [windForce * 0.08 + currentForce * 0.08, windForce + currentForce, (windForce + currentForce) * ship.loa * 0.06]

  const PRETENSION = 60   // kN，系泊预张力
  // 缆绳在系泊工作段的等效弹簧刚度（kN/m），由材质 EA 经等效绳长标定到工程量级
  const workingK = (spec: MooringLineSpec) => Math.max(35, spec.ea / 280)
  const K = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  const geom: { dx: number; dy: number; k: number }[] = []
  for (const ln of plan.lines) {
    const spec = specs.get(ln.specId)
    if (!spec) continue
    // 系船柱换算到船中相对坐标（船中对齐泊位中点）
    const bx = (bollardX.get(ln.bollardId) ?? berthMidX) - berthMidX
    // 缆绳向量：船上导缆孔(shipX, 距码头 12m) → 码头系船柱(bx, 0)
    const vx = bx - ln.shipX
    const vy = -12
    const len = Math.max(8, Math.hypot(vx, vy))
    const dx = vx / len
    const dy = vy / len
    const k = workingK(spec)
    geom.push({ dx, dy, k })
    // 力矩臂：横向分量对船中之矩
    const d = [dx, dy, -dy * ln.shipX]
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        K[i * 3 + j] += k * d[i] * d[j]
  }

  const u = solve3(K, Fext)
  const lines = plan.lines.map((ln, i) => {
    const spec = specs.get(ln.specId)
    const g = geom[i]
    if (!spec || !g) return { ...ln, tension: 0, safety: 0 }
    // 缆绳方向由船指向码头；船向海侧位移与缆绳反向，张力增量为 -k·ext
    const ext = u[0] * g.dx + u[1] * g.dy + u[2] * (-g.dy * ln.shipX)
    const tension = Math.max(PRETENSION, PRETENSION - g.k * ext)
    return { ...ln, tension, safety: spec.mbl / tension }
  })
  return { ...plan, lines, windForce, currentForce }
}

/** 3x3 高斯消元 */
function solve3(A: number[], b: number[]): number[] {
  const aug: number[][] = []
  for (let i = 0; i < 3; i++) aug.push([A[i * 3], A[i * 3 + 1], A[i * 3 + 2], b[i]])
  for (let col = 0; col < 3; col++) {
    let pivot = col
    for (let r = col + 1; r < 3; r++) if (Math.abs(aug[r][col]) > Math.abs(aug[pivot][col])) pivot = r
    ;[aug[col], aug[pivot]] = [aug[pivot], aug[col]]
    const piv = aug[col][col] || 1e-9
    for (let r = 0; r < 3; r++) {
      if (r === col) continue
      const f = aug[r][col] / piv
      for (let c = col; c < 4; c++) aug[r][c] -= f * aug[col][c]
    }
  }
  return [aug[0][3] / aug[0][0], aug[1][3] / aug[1][1], aug[2][3] / aug[2][2]]
}

export const LINE_ROLE_LABEL: Record<MooringLine['role'], string> = {
  head: '头缆',
  stern: '尾缆',
  'breast-forward': '前横缆',
  'breast-aft': '后横缆',
  'spring-forward': '前倒缆',
  'spring-aft': '后倒缆'
}
