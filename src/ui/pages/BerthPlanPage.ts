import type { MooringLine, MooringPlan, ShipType, VesselVisit } from '../../types'
import { getState, setState, subscribe, silentSet } from '../../state/store'
import { currentGeo } from '../../domain/geoCache'
import { defaultLines, envForces, solveMooring, LINE_ROLE_LABEL } from '../../domain/mooring'
import { recomputeSchedule, estimateVisit } from '../../domain/operations'
import { el, mount, select, button, fmt, fmtHour, download } from '../dom'

export class BerthPlanPage {
  private unsub: () => void
  private tab: 'gantt' | 'mooring' = 'gantt'
  private visitId: string
  private canvas: HTMLCanvasElement
  private ro: ResizeObserver

  constructor(private host: HTMLElement) {
    this.visitId = getState().activeVesselId ?? getState().vessels[0].id
    this.canvas = el('canvas', { class: 'scene' }) as HTMLCanvasElement
    this.ro = new ResizeObserver(() => this.drawMooring())
    this.ro.observe(this.canvas)
    // 派生数据在订阅前静默准备，避免渲染重入
    this.ensureSchedule()
    this.ensurePlan(getState().vessels.find(x => x.id === this.visitId)!)
    this.render()
    this.unsub = subscribe(() => this.render())
  }

  destroy() { this.unsub(); this.ro.disconnect() }

  private ensureSchedule() {
    const s = getState()
    if (!s.schedule.length) {
      silentSet(d => { d.schedule = recomputeSchedule(d, currentGeo()) })
    }
  }

  private shipOf(v: VesselVisit): ShipType {
    return getState().shipTypes.find(t => t.id === v.shipTypeId)!
  }

  private ensurePlan(v: VesselVisit): MooringPlan {
    const s = getState()
    let plan = s.mooring[v.id]
    if (!plan) {
      const geo = currentGeo()
      const berth = geo.berths.find(b => b.id === v.berthId)!
      plan = {
        visitId: v.id, windSpeed: 13.8, currentSpeed: 0.8,
        lines: defaultLines(this.shipOf(v), berth, s.lineLib[2].id)
      }
      silentSet(d => { d.mooring[v.id] = this.solve(v, plan!) })
      plan = getState().mooring[v.id]
    }
    return plan
  }

  private solve(v: VesselVisit, plan: MooringPlan): MooringPlan {
    const s = getState()
    const geo = currentGeo()
    const berth = geo.berths.find(b => b.id === v.berthId)!
    const bollardX = new Map(berth.bollards.map(b => [b.id, b.x]))
    const specs = new Map(s.lineLib.map(l => [l.id, l]))
    const berthMidX = (berth.x0 + berth.x1) / 2
    return solveMooring(this.shipOf(v), plan, specs, bollardX, berthMidX)
  }

  private render() {
    const tabs = el('div', { class: 'tabs' },
      el('div', { class: 'tab' + (this.tab === 'gantt' ? ' active' : ''), onclick: () => { this.tab = 'gantt'; this.render() } }, '船期与气象'),
      el('div', { class: 'tab' + (this.tab === 'mooring' ? ' active' : ''), onclick: () => { this.tab = 'mooring'; this.render() } }, '系缆方案设计')
    )
    const body = this.tab === 'gantt' ? this.renderGantt() : this.renderMooring()
    mount(this.host, tabs, body)
    if (this.tab === 'mooring') requestAnimationFrame(() => this.drawMooring())
  }

  // ---------------- 船期甘特 ----------------
  private renderGantt() {
    const s = getState()
    const geo = currentGeo()
    const horizon = 24 * 5
    const weatherRows = el('div', {},
      el('h3', {}, '风力预报与潮汐（未来 5 天，黄条=超靠离泊风速上限 15m/s）'),
      this.weatherStrip(horizon)
    )

    const rows = geo.berths.map(b => {
      const items = s.schedule.filter(i => i.berthId === b.id)
      const bars = items.map(i => {
        const v = s.vessels.find(vv => vv.id === i.visitId)!
        const left = (i.start / horizon) * 100
        const width = Math.max(2, ((i.end ?? i.start) - i.start) / horizon * 100)
        return el('div', {
          class: 'gantt-bar' + (i.warning ? ' warn' : ''),
          style: `left:${left}%;width:${width}%`,
          title: `${v.name} ${fmtHour(i.start)} → ${fmtHour(i.end ?? i.start)}${i.warning ? '\n' + i.warning : ''}`,
          onclick: () => { this.visitId = v.id; this.tab = 'mooring'; this.render() }
        }, v.name)
      })
      return el('div', { class: 'gantt-row' },
        el('div', { style: 'width:70px' }, `泊位${b.index + 1}`),
        el('div', { class: 'gantt-track' }, ...bars)
      )
    })

    const warnings = s.schedule.filter(i => i.warning).map(i => {
      const v = s.vessels.find(vv => vv.id === i.visitId)!
      return el('div', { class: 'warn-text', style: 'margin:4px 0' }, `⚠ ${v.name}：${i.warning}`)
    })

    const util = s.schedule.length
      ? fmt(s.schedule.reduce((sum, i) => sum + ((i.end ?? i.start) - i.start), 0) / (geo.berths.length * horizon) * 100)
      : '0'

    return el('div', {},
      weatherRows,
      el('div', { class: 'card mt16' },
        el('h3', {}, '泊位船期甘特', el('span', { class: 'tag' }, `5 天泊位利用率 ${util}% · 点击船块进入该船系缆设计`)),
        el('div', { style: 'padding:8px 0' }, ...rows),
        warnings.length ? el('div', { class: 'mt16' }, el('h3', {}, '调整建议'), ...warnings) : el('div', { class: 'ok-text mt16' }, '✓ 所有船期均满足靠离泊气象条件')
      ),
      el('div', { class: 'card mt16' },
        el('h3', {}, '完工时间估算（随配载/任务分配即时重算）'),
        this.estimateTable())
    )
  }

  private weatherStrip(horizon: number) {
    const s = getState()
    const cells = s.weather.filter(w => w.t < horizon).map(w => {
      const over = w.windSpeed > 15
      return el('div', {
        style: `flex:1;height:26px;background:${over ? '#7a5a14' : `rgba(47,129,247,${0.15 + w.windSpeed / 40})`};border-right:1px solid #0e1218;font-size:9px;color:#cdd7e5;display:flex;align-items:flex-end;justify-content:center;padding-bottom:2px`,
        title: `t=${w.t}h 风速${w.windSpeed}m/s 潮高${w.tide}m`
      }, w.t % 12 === 0 ? `${w.windSpeed}` : '')
    })
    return el('div', { style: 'display:flex;border:1px solid var(--line);border-radius:6px;overflow:hidden' }, ...cells)
  }

  private estimateTable() {
    const s = getState()
    return el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, '船舶'), el('th', {}, '船型'), el('th', {}, '作业量(moves)'),
        el('th', {}, '投入岸桥'), el('th', {}, '单桥效率'), el('th', {}, '预计完工(h)'), el('th', {}, '靠泊时刻'))),
      el('tbody', {}, ...s.vessels.map(v => {
        const est = estimateVisit(v, s.tasks.filter(t => t.visitId === v.id))
        return el('tr', {},
          el('td', {}, v.name),
          el('td', {}, this.shipOf(v).name),
          el('td', {}, fmt(est.moves, 0)),
          el('td', {}, `${est.loads.length} 台`),
          el('td', {}, `${fmt(est.qcRate)} moves/h`),
          el('td', {}, fmt(est.makespanH)),
          el('td', {}, fmtHour(v.arrival)))
      }))
    )
  }

  // ---------------- 系泊方案 ----------------
  private renderMooring() {
    const s = getState()
    const v = s.vessels.find(x => x.id === this.visitId) ?? s.vessels[0]
    this.visitId = v.id
    const plan = this.ensurePlan(v)
    const ship = this.shipOf(v)
    const env = envForces(ship, plan.windSpeed, plan.currentSpeed)

    const visitSel = select(v.id, s.vessels.map(x => ({ value: x.id, label: `${x.name}（${this.shipOf(x).name}）` })),
      val => { this.visitId = val; this.render() })

    const lineTable = el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, '缆别'), el('th', {}, '材质'), el('th', {}, '直径'),
        el('th', {}, '走向角°'), el('th', {}, '张力 kN'), el('th', {}, '安全系数'), el('th', {}, '状态'))),
      el('tbody', {}, ...plan.lines.map((ln, idx) => this.lineRow(ln, idx, v.id)))
    )

    return el('div', { class: 'grid2', style: 'grid-template-columns:1fr 460px' },
      el('div', { class: 'card' },
        el('h3', {}, '系泊布置示意图', el('span', { class: 'tag' }, '红=安全系数<1.5 黄=<2.0 · 点击缆绳可编辑')),
        el('div', { class: 'canvas-wrap' }, this.canvas),
        el('div', { class: 'btn-row' },
          button('重新自动配缆', () => {
            const geo = currentGeo()
            const berth = geo.berths.find(b => b.id === v.berthId)!
            setState(d => {
              d.mooring[v.id] = this.solve(v, { ...plan, lines: defaultLines(ship, berth, s.lineLib[2].id) })
            })
          }),
          button('导出带缆布置图 SVG', () => this.exportSvg(v, plan)),
          button('导出缆绳核算表', () => this.exportLinesCsv(plan))
        )
      ),
      el('div', { class: 'card scroll-y' },
        el('h3', {}, '工况与缆绳库'),
        el('label', { class: 'field' }, el('span', {}, '选择船舶'), visitSel),
        el('label', { class: 'field' }, el('span', {}, '横风风速 m/s（六级≈13.8）'),
          numField(plan.windSpeed, val => this.updatePlan(v.id, p => { p.windSpeed = val }), 0.1)),
        el('label', { class: 'field' }, el('span', {}, '横流流速 m/s'),
          numField(plan.currentSpeed, val => this.updatePlan(v.id, p => { p.currentSpeed = val }), 0.1)),
        el('div', { class: 'mt16' },
          el('div', {}, `风载荷：${fmt(env.windForce)} kN`),
          el('div', {}, `流载荷：${fmt(env.currentForce)} kN`),
          el('div', { class: 'muted mt8' }, `船长 ${ship.loa}m · 型宽 ${ship.beam}m · 水上侧面积 ${ship.windArea}m² · 水下 ${ship.currentArea}m²`)),
        el('h3', { class: 'mt16' }, '逐根缆绳张力校核'),
        lineTable,
        el('div', { class: 'muted mt8', style: 'font-size:11px' }, '安全系数=破断拉力/工作张力，限值 1.5，预警 2.0')
      )
    )
  }

  private lineRow(ln: MooringLine, idx: number, visitId: string) {
    const s = getState()
    const spec = s.lineLib.find(l => l.id === ln.specId)!
    const over = ln.safety < 1.5
    const near = !over && ln.safety < 2.0
    return el('tr', { class: 'line-row' + (over ? ' overlimit' : near ? ' nearlimit' : '') },
      el('td', {}, LINE_ROLE_LABEL[ln.role]),
      el('td', {}, select(spec.id, s.lineLib.map(l => ({ value: l.id, label: `${l.material} Φ${l.diameter}` })),
        val => this.updatePlan(visitId, p => { p.lines[idx].specId = val }))),
      el('td', {}, `${spec.diameter}`),
      el('td', {}, numField(ln.angleDeg, val => this.updatePlan(visitId, p => { p.lines[idx].angleDeg = val }), 1, true)),
      el('td', { class: over ? 'alarm-text' : '' }, fmt(ln.tension)),
      el('td', { class: over ? 'alarm-text' : near ? 'warn-text' : 'ok-text' }, fmt(ln.safety, 2)),
      el('td', {}, over ? el('span', { class: 'alarm-text' }, '超限') : near ? el('span', { class: 'warn-text' }, '预警') : el('span', { class: 'ok-text' }, '合格'))
    )
  }

  private updatePlan(visitId: string, mutate: (p: MooringPlan) => void) {
    setState(d => {
      const p = d.mooring[visitId]
      if (!p) return
      mutate(p)
      const v = d.vessels.find(x => x.id === visitId)!
      d.mooring[visitId] = this.solve(v, p)
    })
  }

  private drawMooring() {
    const s = getState()
    const v = s.vessels.find(x => x.id === this.visitId)
    if (!v) return
    const plan = s.mooring[v.id]
    if (!plan) return
    const ship = this.shipOf(v)
    const geo = currentGeo()
    const berth = geo.berths.find(b => b.id === v.berthId)!
    const cv = this.canvas
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = cv.clientWidth, h = cv.clientHeight
    if (!w) return
    cv.width = w * dpr; cv.height = h * dpr
    const ctx = cv.getContext('2d')!
    ctx.scale(dpr, dpr)
    ctx.fillStyle = '#0b0f14'
    ctx.fillRect(0, 0, w, h)

    const scale = Math.min((w - 80) / ship.loa, (h - 120) / 60)
    const cx = w / 2
    const quayY = h * 0.28
    const shipY = h * 0.62
    const X = (sx: number) => cx + sx * scale

    // 码头线与系船柱
    ctx.strokeStyle = '#5a6a80'
    ctx.lineWidth = 3
    ctx.beginPath(); ctx.moveTo(X(-ship.loa / 2 - 30), quayY); ctx.lineTo(X(ship.loa / 2 + 30), quayY); ctx.stroke()
    ctx.lineWidth = 1
    ctx.fillStyle = '#c9d4e3'
    for (const bol of berth.bollards) {
      const bx = X((bol.x - (berth.x0 + berth.x1) / 2))
      ctx.fillRect(bx - 3, quayY - 8, 6, 8)
    }
    ctx.fillStyle = '#8493a8'; ctx.font = '11px sans-serif'
    ctx.fillText('码头面 / 系船柱', X(-ship.loa / 2 - 30), quayY - 14)

    // 船体
    ctx.fillStyle = '#1d3557'
    ctx.strokeStyle = '#4a78b8'
    ctx.beginPath()
    ctx.roundRect(X(-ship.loa / 2), shipY - 14, ship.loa * scale, 28, 12)
    ctx.fill(); ctx.stroke()
    ctx.fillStyle = '#9fc0ea'
    ctx.font = '12px sans-serif'
    ctx.fillText(`${v.name} · ${ship.name}`, cx - 60, shipY + 4)
    // 首尾标记
    ctx.fillText('艏 →', X(ship.loa / 2) - 34, shipY + 4)
    ctx.fillText('← 艉', X(-ship.loa / 2) + 6, shipY + 4)

    // 导缆孔 + 缆绳
    for (const ln of plan.lines) {
      const bol = berth.bollards.find(b => b.id === ln.bollardId)!
      const bx = X(bol.x - (berth.x0 + berth.x1) / 2)
      const sx = X(ln.shipX)
      const over = ln.safety < 1.5
      const near = !over && ln.safety < 2.0
      ctx.strokeStyle = over ? '#f85149' : near ? '#d29922' : '#3fb950'
      ctx.lineWidth = 2
      ctx.beginPath(); ctx.moveTo(bx, quayY); ctx.lineTo(sx, shipY - 12); ctx.stroke()
      ctx.fillStyle = '#fff'
      ctx.beginPath(); ctx.arc(sx, shipY - 12, 3, 0, Math.PI * 2); ctx.fill()
      // 标签
      const mx = (bx + sx) / 2, my = (quayY + shipY - 12) / 2
      ctx.fillStyle = over ? '#ff8177' : near ? '#e3b341' : '#7ee787'
      ctx.font = '10px sans-serif'
      ctx.fillText(`${LINE_ROLE_LABEL[ln.role]} ${fmt(ln.tension, 0)}kN`, mx, my)
    }

    // 工况箭头
    ctx.fillStyle = '#58a6ff'
    ctx.font = '11px sans-serif'
    ctx.fillText(`← 六级横风 ${plan.windSpeed}m/s    横流 ${plan.currentSpeed}m/s →`, 16, h - 20)
  }

  private exportSvg(v: VesselVisit, plan: MooringPlan) {
    const ship = this.shipOf(v)
    const geo = currentGeo()
    const berth = geo.berths.find(b => b.id === v.berthId)!
    const w = 1000, h = 420
    const scale = Math.min((w - 100) / ship.loa, (h - 160) / 60)
    const cx = w / 2, quayY = 110, shipY = 260
    const X = (sx: number) => cx + sx * scale
    const bollardEls = berth.bollards.map(b =>
      `<rect x="${X(b.x - (berth.x0 + berth.x1) / 2) - 4}" y="${quayY - 10}" width="8" height="10" fill="#c9d4e3"/>`).join('')
    const lineEls = plan.lines.map(ln => {
      const bol = berth.bollards.find(b => b.id === ln.bollardId)!
      const color = ln.safety < 1.5 ? '#f85149' : ln.safety < 2 ? '#d29922' : '#3fb950'
      return `<line x1="${X(bol.x - (berth.x0 + berth.x1) / 2)}" y1="${quayY}" x2="${X(ln.shipX)}" y2="${shipY - 14}" stroke="${color}" stroke-width="2"/>
        <text x="${(X(bol.x - (berth.x0 + berth.x1) / 2) + X(ln.shipX)) / 2}" y="${(quayY + shipY) / 2}" fill="${color}" font-size="11">${LINE_ROLE_LABEL[ln.role]} ${ln.tension.toFixed(0)}kN</text>`
    }).join('')
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="#0b0f14"/>
<text x="20" y="34" fill="#fff" font-size="18">${v.name} 系泊带缆布置图（横风${plan.windSpeed}m/s 横流${plan.currentSpeed}m/s）</text>
<line x1="40" y1="${quayY}" x2="${w - 40}" y2="${quayY}" stroke="#5a6a80" stroke-width="3"/>${bollardEls}
<rect x="${X(-ship.loa / 2)}" y="${shipY - 16}" width="${ship.loa * scale}" height="32" rx="14" fill="#1d3557" stroke="#4a78b8"/>
<text x="${cx - 80}" y="${shipY + 5}" fill="#9fc0ea" font-size="13">${ship.name} LOA ${ship.loa}m</text>${lineEls}
<text x="20" y="${h - 20}" fill="#58a6ff" font-size="12">红:安全系数&lt;1.5 黄:&lt;2.0 绿:合格 · 生成于仿真平台</text></svg>`
    download(`${v.name}_系泊布置图.svg`, svg, 'image/svg+xml')
  }

  private exportLinesCsv(plan: MooringPlan) {
    const s = getState()
    const rows = [['缆别', '材质', '直径mm', '破断拉力kN', '走向角°', '张力kN', '安全系数', '结论']]
    for (const ln of plan.lines) {
      const spec = s.lineLib.find(l => l.id === ln.specId)!
      rows.push([LINE_ROLE_LABEL[ln.role], spec.material, String(spec.diameter), String(spec.mbl),
        String(ln.angleDeg), ln.tension.toFixed(1), ln.safety.toFixed(2), ln.safety < 1.5 ? '超限' : ln.safety < 2 ? '预警' : '合格'])
    }
    download('缆绳核算表.csv', '﻿' + rows.map(r => r.join(',')).join('\n'), 'text/csv')
  }
}

function numField(value: number, onInput: (v: number) => void, step = 1, compact = false) {
  const input = el('input', {
    type: 'number', value, step, ...(compact ? { style: 'width:80px' } : {}),
    oninput: () => {
      const v = parseFloat((input as HTMLInputElement).value)
      if (!Number.isNaN(v)) onInput(v)
    }
  })
  return input
}
