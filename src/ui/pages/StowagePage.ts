import type { Container, ShipType, StowCell, VesselVisit } from '../../types'
import { getState, setState, subscribe } from '../../state/store'
import { autoStow, computeStability, makeVisit } from '../../domain/stowage'
import { currentGeo } from '../../domain/geoCache'
import { decomposeTasks, recomputeSchedule } from '../../domain/operations'
import { el, mount, select, button, fmt, labeled, textInput, numInput } from '../dom'
import { containerColorHex } from '../colors'

export class StowagePage {
  private unsub: () => void
  private visitId: string
  private bayFilter: number | null = null
  private dragFrom: { bay: number; row: number; tier: number } | null = null

  constructor(private host: HTMLElement) {
    this.unsub = subscribe(() => this.render())
    this.visitId = getState().activeVesselId ?? getState().vessels[0].id
    this.render()
  }
  destroy() { this.unsub() }

  private visit(): VesselVisit {
    return getState().vessels.find(v => v.id === this.visitId) ?? getState().vessels[0]
  }
  private ship(): ShipType {
    return getState().shipTypes.find(t => t.id === this.visit().shipTypeId)!
  }

  private render() {
    const s = getState()
    const v = this.visit()
    const ship = this.ship()
    const stab = computeStability(ship, v.cells, s.containers)
    const gmBad = stab.gm < ship.gmLimit
    const heelBad = Math.abs(stab.heelDeg) > ship.heelLimitDeg

    const left = el('div', { class: 'card scroll-y' },
      el('h3', {}, '船舶/船型档案'),
      labeled('选择航次', select(v.id, s.vessels.map(x => ({ value: x.id, label: `${x.name} · ${s.shipTypes.find(t => t.id === x.shipTypeId)!.name}` })),
        id => { this.visitId = id; this.bayFilter = null; this.render() })),
      this.shipTypeEditor(ship),
      el('h3', { class: 'mt16' }, '航次操作'),
      el('div', { class: 'btn-row' },
        button('自动配载', () => this.runAuto(), 'btn primary'),
        button('整版复制历史航次', () => this.copyHistory()),
        button('清空船图', () => setState(d => {
          const vv = d.vessels.find(x => x.id === this.visitId)!
          vv.cells.forEach(c => (c.containerId = null))
          this.rebuildTasks(d)
        })),
        button('新建航次', () => this.newVisit())
      ),
      el('div', { class: 'muted mt8', style: 'font-size:11px' },
        '规则：后卸港压上层 · 重箱在下 · 冷藏进插座(虚线格) · 危品按类别隔离 · 左右舷对称控制横倾')
    )

    const center = el('div', { class: 'card' },
      el('h3', {}, `贝位图（${v.name}）`,
        el('span', { class: 'tag' }, `贝位规则：${ship.bayRule} · 可直接拖动箱格互换`)),
      this.bayTabs(v),
      el('div', { style: 'overflow:auto;max-height:calc(100vh - 300px)' }, this.bayGrid(v))
    )

    const right = el('div', { class: 'card scroll-y' },
      el('h3', {}, '稳性实时校核'),
      this.stabRow('初稳性高 GM', `${fmt(stab.gm, 3)} m`, `限值 ≥ ${ship.gmLimit} m`, gmBad),
      this.stabRow('横倾角', `${fmt(stab.heelDeg, 2)} °`, `限值 ±${ship.heelLimitDeg}°`, heelBad),
      this.stabRow('重心高度 KG', `${fmt(stab.kg, 2)} m`, '随配载实时变化', false),
      this.stabRow('总载重量', `${fmt(stab.totalWeight, 0)} t`, `含空船 ${ship.lightshipDisp}t`, false),
      el('div', { class: (gmBad || heelBad ? 'alarm-text' : 'ok-text') + ' mt16' },
        gmBad || heelBad ? '⚠ 超出稳性限值，请调整配载（重箱下移/左右均衡）' : '✓ 稳性满足要求'),
      el('h3', { class: 'mt16' }, '在船箱分类'),
      this.cargoSummary(v),
      el('h3', { class: 'mt16' }, '目的港层带'),
      ...v.dischargePorts.map((p, i) => el('div', { class: 'flex-between', style: 'margin:4px 0' },
        el('span', {}, `${i + 1}. ${p}（${i === v.dischargePorts.length - 1 ? '后卸，压上层' : '先卸'}）`),
        el('span', { class: 'muted' }, `${v.cells.filter(c => c.containerId && s.containers[c.containerId!]?.port === p).length} 箱`)))
    )

    mount(this.host, el('div', { class: 'grid3' }, left, center, right))
  }

  private shipTypeEditor(ship: ShipType) {
    const upd = (field: keyof ShipType, val: number | string) => setState(d => {
      const t = d.shipTypes.find(x => x.id === ship.id)!
      ;(t as unknown as Record<string, unknown>)[field] = val
    })
    const num = (label: string, field: keyof ShipType, val: number, step = 1) =>
      labeled(label, numInput(val, v => upd(field, v), step))
    return el('div', { class: 'mt16' },
      el('h3', {}, '船型参数', el('span', { class: 'tag' }, '改贝位/层数自动重建骨架')),
      labeled('船型名称', textInput(ship.name, val => upd('name', val))),
      num('船长 LOA (m)', 'loa', ship.loa),
      num('型宽 (m)', 'beam', ship.beam),
      num('舱内层数', 'holdTiers', ship.holdTiers),
      num('甲板层数', 'deckTiers', ship.deckTiers),
      num('横向排数', 'rows', ship.rows),
      num('贝位数', 'bayCount', ship.bayCount),
      num('冷藏插座数', 'reeferSlots', ship.reeferSlots.length),
      num('GM 限值 (m)', 'gmLimit', ship.gmLimit, 0.1),
      num('横倾角限值 (°)', 'heelLimitDeg', ship.heelLimitDeg, 1),
      labeled('贝位编号规则', textInput(ship.bayRule, val => upd('bayRule', val))),
      button('按新参数重建贝位骨架', () => setState(d => {
        const t = d.shipTypes.find(x => x.id === ship.id)!
        const vv = d.vessels.find(x => x.id === this.visitId)!
        vv.cells = makeVisit(t, vv.name, vv.arrival, vv.berthId).cells
        this.rebuildTasks(d)
      }), 'btn sm')
    )
  }

  private bayTabs(v: VesselVisit) {
    const bays = [...new Set(v.cells.map(c => c.bay))].sort((a, b) => a - b)
    if (this.bayFilter === null) this.bayFilter = bays[0]
    return el('div', { class: 'tabs', style: 'flex-wrap:wrap' },
      ...bays.map(b => el('div', {
        class: 'tab' + (this.bayFilter === b ? ' active' : ''),
        style: 'padding:4px 10px',
        onclick: () => { this.bayFilter = b; this.render() }
      }, `贝${String(b).padStart(2, '0')}`)))
  }

  private bayGrid(v: VesselVisit) {
    const cells = v.cells.filter(c => c.bay === this.bayFilter)
    const rows = [...new Set(cells.map(c => c.row))].sort((a, b) => b - a)
    const tiers = [...new Set(cells.map(c => c.tier))].sort((a, b) => b - a)
    const s = getState()

    const grid = el('div', {
      class: 'bay-grid',
      style: `grid-template-columns: 46px repeat(${tiers.length}, 36px);width:max-content`
    },
      el('div', { class: 'muted', style: 'font-size:10px;display:flex;align-items:center' }, '排\\层'),
      ...tiers.map(t => el('div', { class: 'muted', style: 'font-size:10px;text-align:center' }, String(t))),
      ...rows.flatMap(row => [
        el('div', { class: 'muted', style: `font-size:10px;display:flex;align-items:center;${row < 0 ? 'color:#7cb2ff' : 'color:#f0a868'}` },
          `${row < 0 ? '左' : '右'}${Math.abs(row)}`),
        ...tiers.map(tier => {
          const cell = cells.find(c => c.row === row && c.tier === tier)!
          return this.cellEl(v, cell, s.containers[cell.containerId ?? ''])
        })
      ])
    )
    return grid
  }

  private cellEl(v: VesselVisit, cell: StowCell, c?: Container) {
    const bg = c ? containerColorHex(c) : cell.reefer ? 'transparent' : '#10151d'
    const node = el('div', {
      class: 'cell' + (c ? '' : ' empty') + (cell.reefer ? ' reefer-slot' : ''),
      style: `background:${bg}`,
      draggable: c ? 'true' : 'false',
      title: c ? `${c.no} · ${c.port} · ${c.weight}t · ${c.kind === 'dg' ? '危品' + c.dgClass + '类 ' : ''}${cell.deck ? '甲板' : '舱内'}` : (cell.reefer ? '冷藏插座位' : '空位'),
      ondragstart: () => { this.dragFrom = { bay: cell.bay, row: cell.row, tier: cell.tier } },
      ondragover: (e: Event) => { e.preventDefault(); node.classList.add('dragover') },
      ondragleave: () => node.classList.remove('dragover'),
      ondrop: (e: Event) => {
        e.preventDefault(); node.classList.remove('dragover')
        this.swap(v.id, this.dragFrom!, { bay: cell.bay, row: cell.row, tier: cell.tier })
        this.dragFrom = null
      }
    }, c ? el('span', {}, c.weightClass) : (cell.reefer ? 'R' : ''))
    if (c?.kind === 'dg') node.append(el('span', { class: 'dg-mark' }, String(c.dgClass)))
    return node
  }

  private swap(visitId: string, from: { bay: number; row: number; tier: number }, to: { bay: number; row: number; tier: number }) {
    setState(d => {
      const v = d.vessels.find(x => x.id === visitId)!
      const a = v.cells.find(c => c.bay === from.bay && c.row === from.row && c.tier === from.tier)!
      const b = v.cells.find(c => c.bay === to.bay && c.row === to.row && c.tier === to.tier)!
      // 冷藏箱不能放进非插座
      if (a.containerId) {
        const ct = d.containers[a.containerId]
        if (ct.kind === 'reefer' && !b.reefer) { alert('冷藏箱只能放在冷藏插座位（虚线格）'); return }
      }
      const tmp = a.containerId
      a.containerId = b.containerId
      b.containerId = tmp
      this.rebuildTasks(d)
    })
  }

  private runAuto() {
    const s = getState()
    const v = this.visit()
    const result = autoStow(this.ship(), v, s.containers)
    setState(d => {
      const vv = d.vessels.find(x => x.id === v.id)!
      vv.cells = result.cells
      this.rebuildTasks(d)
    })
    if (result.violations.length) alert('自动配载完成，存在以下告警：\n' + result.violations.join('\n'))
    else alert(`自动配载完成：${result.cells.filter(c => c.containerId).length} 箱已就位，稳性合格`)
  }

  private copyHistory() {
    const s = getState()
    const others = s.vessels.filter(x => x.shipTypeId === this.ship().id && x.id !== this.visitId)
    if (!others.length) return alert('同船型暂无其他航次可复制')
    const src = others[0]
    setState(d => {
      const vv = d.vessels.find(x => x.id === this.visitId)!
      const srcV = d.vessels.find(x => x.id === src.id)!
      vv.cells = srcV.cells.map(c => ({ ...c }))
      vv.historyFrom = src.id
      this.rebuildTasks(d)
    })
    alert(`已整版复制「${src.name}」配载，可在此基础上修改`)
  }

  private newVisit() {
    const s = getState()
    const geo = currentGeo()
    const v = makeVisit(this.ship(), `新航次 ${s.vessels.length + 1}`, s.vessels.length * 24, geo.berths[0].id)
    setState(d => {
      d.vessels.push(v)
      d.activeVesselId = v.id
      this.visitId = v.id
    })
  }

  private rebuildTasks(d: ReturnType<typeof getState>) {
    // 配载变化 → 任务重拆 → 船期/完工时间级联重算（同步即时）
    const geo = currentGeo()
    d.tasks = d.vessels.flatMap(vv => decomposeTasks(vv, geo))
    d.schedule = recomputeSchedule(d, geo)
  }

  private stabRow(label: string, value: string, limit: string, bad: boolean) {
    return el('div', { style: 'margin-bottom:10px' },
      el('div', { class: 'muted', style: 'font-size:11px' }, label),
      el('div', { style: `font-size:20px;font-weight:700;color:${bad ? 'var(--alarm)' : '#fff'}` }, value),
      el('div', { class: 'muted', style: 'font-size:10px' }, limit))
  }

  private cargoSummary(v: VesselVisit) {
    const s = getState()
    const ids = v.cells.filter(c => c.containerId).map(c => c.containerId!)
    const count = (pred: (c: Container) => boolean) => ids.filter(id => pred(s.containers[id])).length
    const row = (label: string, n: number, cls: string) =>
      el('div', { class: 'flex-between', style: 'margin:4px 0' },
        el('span', {}, el('span', { class: `badge ${cls}` }, label), ` ${n} 箱`),
        el('span', { class: 'muted' }, `${fmt((n / Math.max(1, ids.length)) * 100, 0)}%`))
    return el('div', {},
      row('出口', count(c => c.flow === 'export'), 'export'),
      row('进口', count(c => c.flow === 'import'), 'import'),
      row('中转', count(c => c.flow === 'transit'), 'transit'),
      row('冷藏', count(c => c.kind === 'reefer'), 'reefer'),
      row('危险品', count(c => c.kind === 'dg'), 'dg'),
      row('空箱', count(c => c.kind === 'empty'), 'empty'))
  }
}

