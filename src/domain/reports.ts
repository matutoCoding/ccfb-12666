import type { AppState, ReportBundle, ReportRow } from '../types'
import { berthUtilization } from './operations'

/** 生成日报/周报。历史周期以当前方案为基线做确定性波动，保证涨跌对比可复现。 */
export function generateReports(state: AppState, berthCount: number): ReportBundle {
  const daily: ReportRow[] = []
  const baseUtil = berthUtilization(state.schedule, berthCount, 24)
  const util0 = Math.min(95, Math.max(20, baseUtil || 58))
  const re0 = 12

  for (let d = 6; d >= 0; d--) {
    const seed = mulberry32(20261119 - d * 77)
    daily.push({
      period: `第${7 - d}日 (11/${13 + (6 - d)})`,
      berthUtil: clamp(util0 + (seed() - 0.5) * 14, 10, 98),
      qcEfficiency: clamp(28 + (seed() - 0.5) * 8, 18, 38),
      truckWait: clamp(9 + (seed() - 0.5) * 6, 2, 25),
      rehandleRate: clamp(re0 + (seed() - 0.5) * 5, 3, 28)
    })
  }
  daily.forEach((r, i) => {
    if (i === 0) { r.deltas = { berthUtil: 3.2, qcEfficiency: 1.1, truckWait: -0.8, rehandleRate: -1.4 }; return }
    const prev = daily[i - 1]
    r.deltas = {
      berthUtil: +(r.berthUtil - prev.berthUtil).toFixed(1),
      qcEfficiency: +(r.qcEfficiency - prev.qcEfficiency).toFixed(1),
      truckWait: +(r.truckWait - prev.truckWait).toFixed(1),
      rehandleRate: +(r.rehandleRate - prev.rehandleRate).toFixed(1)
    }
  })

  const weekly: ReportRow[] = []
  for (let w = 3; w >= 0; w--) {
    const seed = mulberry32(91000 + w * 131)
    weekly.push({
      period: `第${4 - w}周`,
      berthUtil: clamp(util0 + (seed() - 0.5) * 8, 20, 95),
      qcEfficiency: clamp(28 + (seed() - 0.5) * 5, 20, 36),
      truckWait: clamp(9 + (seed() - 0.5) * 4, 4, 20),
      rehandleRate: clamp(re0 + (seed() - 0.5) * 3, 5, 22)
    })
  }
  weekly.forEach((r, i) => {
    if (i === 0) { r.deltas = { berthUtil: 2.1, qcEfficiency: 0.6, truckWait: -1.2, rehandleRate: -0.9 }; return }
    const prev = weekly[i - 1]
    r.deltas = {
      berthUtil: +(r.berthUtil - prev.berthUtil).toFixed(1),
      qcEfficiency: +(r.qcEfficiency - prev.qcEfficiency).toFixed(1),
      truckWait: +(r.truckWait - prev.truckWait).toFixed(1),
      rehandleRate: +(r.rehandleRate - prev.rehandleRate).toFixed(1)
    }
  })

  return { daily, weekly, generatedAt: Date.now() }
}

function clamp(v: number, lo: number, hi: number) { return +Math.min(hi, Math.max(lo, v)).toFixed(1) }

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
