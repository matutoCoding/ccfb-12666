import type { ReportRow } from '../../types'
import { getState, setState, subscribe, silentSet } from '../../state/store'
import { currentGeo } from '../../domain/geoCache'
import { generateReports } from '../../domain/reports'
import { exportReportsExcel } from '../../domain/excel'
import { berthUtilization } from '../../domain/operations'
import { yardStats } from '../../domain/yard'
import { el, mount, button, fmt } from '../dom'

export class ReportsPage {
  private unsub: () => void
  private mode: 'daily' | 'weekly' = 'daily'

  constructor(private host: HTMLElement) {
    if (!getState().reports) {
      silentSet(d => { d.reports = generateReports(d, currentGeo().berths.length) })
    }
    this.render()
    this.unsub = subscribe(() => this.render())
  }
  destroy() { this.unsub() }

  private render() {
    const s = getState()
    const geo = currentGeo()
    const bundle = s.reports ?? generateReports(s, geo.berths.length)
    const rows = this.mode === 'daily' ? bundle.daily : bundle.weekly
    const latest = rows[rows.length - 1]
    const yard = yardStats(s, geo.blocks)
    const liveRehandle = yard.reduce((a, b) => a + b.rehandleRate, 0) / Math.max(1, yard.length)
    const liveUtil = berthUtilization(s.schedule, geo.berths.length, 24 * 5)

    const kpis = el('div', { class: 'kpi-row' },
      this.kpi('泊位利用率', `${fmt(latest.berthUtil)}%`, latest.deltas?.berthUtil, '%', liveUtil),
      this.kpi('岸桥单机效率', `${fmt(latest.qcEfficiency)}`, latest.deltas?.qcEfficiency, 'moves/h'),
      this.kpi('集卡平均等待', `${fmt(latest.truckWait)}`, latest.deltas?.truckWait, 'min', undefined, true),
      this.kpi('堆场翻箱率', `${fmt(latest.rehandleRate)}%`, latest.deltas?.rehandleRate, '%', liveRehandle))

    const table = el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, '周期'),
        el('th', {}, '泊位利用率'), el('th', {}, '环比'),
        el('th', {}, '岸桥效率(moves/h)'), el('th', {}, '环比'),
        el('th', {}, '集卡等待(min)'), el('th', {}, '环比'),
        el('th', {}, '翻箱率(%)'), el('th', {}, '环比'))),
      el('tbody', {}, ...rows.map(r => el('tr', {},
        el('td', {}, r.period),
        el('td', {}, `${fmt(r.berthUtil)}%`), this.delta(r.deltas?.berthUtil, '%'),
        el('td', {}, fmt(r.qcEfficiency)), this.delta(r.deltas?.qcEfficiency),
        el('td', {}, fmt(r.truckWait)), this.delta(r.deltas?.truckWait, 'min', true),
        el('td', {}, `${fmt(r.rehandleRate)}%`), this.delta(r.deltas?.rehandleRate, '%', true))))
    )

    const card = el('div', { class: 'card' },
      el('h3', {}, this.mode === 'daily' ? '日报（近 7 日）' : '周报（近 4 周）',
        el('span', { class: 'tag' }, '环比自动对比，绿涨红跌（等待/翻箱率反向解读）')),
      el('div', { class: 'tabs' },
        el('div', { class: 'tab' + (this.mode === 'daily' ? ' active' : ''), onclick: () => { this.mode = 'daily'; this.render() } }, '日报'),
        el('div', { class: 'tab' + (this.mode === 'weekly' ? ' active' : ''), onclick: () => { this.mode = 'weekly'; this.render() } }, '周报')),
      table,
      el('div', { class: 'btn-row mt16' },
        button('导出 Excel（日报+周报）', () => exportReportsExcel(bundle.daily, bundle.weekly), 'btn primary'),
        button('按当前方案重新生成', () => setState(d => { d.reports = generateReports(d, currentGeo().berths.length) })))
    )

    mount(this.host, kpis, card,
      el('div', { class: 'card mt16' },
        el('h3', {}, '当前方案实时指标（与报表口径对照）'),
        el('div', { class: 'muted' },
          `实时泊位利用率（5 天窗口）：${fmt(liveUtil)}% · 实时堆场翻箱率：${fmt(liveRehandle)}% · ` +
          `箱区数：${geo.blocks.length} · 在场箱：${fmt(Object.values(s.yard).filter(Boolean).length, 0)} TEU`),
        this.miniBars(rows)))
  }

  private kpi(label: string, value: string, delta?: number, unit = '', live?: number, invert = false) {
    const good = delta === undefined ? null : invert ? delta <= 0 : delta >= 0
    return el('div', { class: 'kpi' },
      el('div', { class: 'label' }, label),
      el('div', { class: 'value' }, value),
      el('div', { class: 'delta ' + (good === null ? 'muted' : good ? 'up' : 'down') },
        delta === undefined ? '—' : `${delta > 0 ? '▲ +' : '▼ '}${fmt(delta)}${unit} 环比`,
        live !== undefined ? el('span', { class: 'muted', style: 'margin-left:8px' }, `实时 ${fmt(live)}${unit}`) : null))
  }

  private delta(v?: number, unit = '', invert = false) {
    if (v === undefined) return el('td', { class: 'muted' }, '—')
    const good = invert ? v <= 0 : v >= 0
    return el('td', { class: good ? 'up' : 'down' }, `${v > 0 ? '+' : ''}${fmt(v)}${unit}`)
  }

  private miniBars(rows: ReportRow[]) {
    const bar = (label: string, key: keyof Pick<ReportRow, 'berthUtil' | 'qcEfficiency' | 'truckWait' | 'rehandleRate'>, max: number) =>
      el('div', { style: 'flex:1' },
        el('div', { class: 'muted', style: 'font-size:11px;margin-bottom:4px' }, label),
        el('div', { style: 'display:flex;gap:3px;align-items:flex-end;height:70px' },
          ...rows.map(r => el('div', {
            style: `width:100%;height:${Math.max(3, (r[key] / max) * 100)}%;background:var(--accent);border-radius:2px 2px 0 0`,
            title: `${r.period}: ${fmt(r[key])}`
          }))))
    return el('div', { class: 'mt16', style: 'display:flex;gap:18px' },
      bar('泊位利用率 %', 'berthUtil', 100),
      bar('岸桥效率', 'qcEfficiency', 40),
      bar('集卡等待 min', 'truckWait', 25),
      bar('翻箱率 %', 'rehandleRate', 30))
  }
}
