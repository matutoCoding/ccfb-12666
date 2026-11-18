import type { BlockGeo, Container } from '../../types'
import { slotKey } from '../../types'
import { getState, setState, subscribe } from '../../state/store'
import { currentGeo } from '../../domain/geoCache'
import { yardStats, optimalPickSequence } from '../../domain/yard'
import { InstancedRenderer } from '../../gl/renderer'
import { buildScene, PICK_ENTITY_BASE } from '../../gl/scene'
import { el, mount, select, button, fmt } from '../dom'
import { containerColorHex } from '../colors'

export class YardPage {
  private unsub: () => void
  private renderer: InstancedRenderer | null = null
  private raf = 0
  private blockId: string
  private pickInfo: { container?: Container; text: string[] } | null = null

  constructor(private host: HTMLElement) {
    this.unsub = subscribe(() => this.render())
    this.blockId = currentGeo().blocks[0].id
    this.render()
  }

  destroy() {
    this.unsub()
    cancelAnimationFrame(this.raf)
    this.renderer = null
  }

  private render() {
    const s = getState()
    const geo = currentGeo()
    const stats = yardStats(s, geo.blocks)

    const kpis = el('div', { class: 'kpi-row' },
      this.kpi('堆场总容量', `${fmt(geo.blocks.reduce((a, b) => a + b.bays * b.rows * b.tiers, 0))}`, 'TEU'),
      this.kpi('当前在场量', `${fmt(stats.reduce((a, b) => a + b.occupied, 0))}`, 'TEU'),
      this.kpi('平均占用率', `${fmt(stats.reduce((a, b) => a + b.occupancy, 0) / stats.length)}%`, ''),
      this.kpi('平均翻箱率', `${fmt(stats.reduce((a, b) => a + b.rehandleRate, 0) / stats.length)}%`, ''))

    const statTable = el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, '箱区'), el('th', {}, '容量'), el('th', {}, '在场'),
        el('th', {}, '占用率'), el('th', {}, '翻箱数'), el('th', {}, '翻箱率'), el('th', {}, ''))),
      el('tbody', {}, ...geo.blocks.map((b, i) => {
        const st = stats[i]
        return el('tr', {},
          el('td', {}, `箱区${i + 1}`),
          el('td', {}, fmt(st.capacity, 0)),
          el('td', {}, fmt(st.occupied, 0)),
          el('td', {}, this.bar(st.occupancy)),
          el('td', {}, String(st.rehandles)),
          el('td', { class: st.rehandleRate > 15 ? 'alarm-text' : st.rehandleRate > 8 ? 'warn-text' : 'ok-text' }, `${fmt(st.rehandleRate)}%`),
          el('td', {}, button('取箱规划', () => { this.blockId = b.id; this.showPickPlan(b) }, 'btn sm')))
      })))

    const canvas = el('canvas', { class: 'scene' }) as HTMLCanvasElement
    const left = el('div', { class: 'card' },
      el('h3', {}, '堆场三维视图', el('span', { class: 'tag' }, '左键旋转 · 右键平移 · 滚轮缩放 · 点击箱子查看信息')),
      el('div', { class: 'canvas-wrap' }, canvas,
        el('div', { class: 'overlay-legend' },
          el('span', {}, el('span', { class: 'legend-dot', style: 'background:#599ef2' }), '出口'),
          el('span', {}, el('span', { class: 'legend-dot', style: 'background:#8cbf59' }), '进口'),
          el('span', {}, el('span', { class: 'legend-dot', style: 'background:#f2c74d' }), '中转'),
          el('span', {}, el('span', { class: 'legend-dot', style: 'background:#33ccc0' }), '冷藏'),
          el('span', {}, el('span', { class: 'legend-dot', style: 'background:#e64038' }), '危险品')),
        el('div', { class: 'overlay-hud', id: 'yard-hud' }, this.hudContent()))
    )

    const right = el('div', { class: 'card scroll-y' },
      el('h3', {}, '箱区指标'), statTable,
      el('h3', { class: 'mt16' }, '箱区详情'),
      this.blockDetail(geo.blocks.find(b => b.id === this.blockId)!),
      el('div', { id: 'pick-panel', class: 'mt16' }, this.pickPanel(geo.blocks.find(b => b.id === this.blockId)!))
    )

    mount(this.host, el('div', {},
      kpis,
      el('div', { class: 'grid2', style: 'grid-template-columns:1fr 420px;height:calc(100vh - 220px)' }, left, right)))

    this.initGl(canvas)
  }

  private initGl(canvas: HTMLCanvasElement) {
    const r = new InstancedRenderer(canvas)
    this.renderer = r
    r.attachControls()
    const s = getState()
    const geo = currentGeo()
    // 相机取景：以堆场箱区范围（而非整个含水域的码头矩形）为目标，距离紧凑让万箱可见
    const blk = geo.blocks
    const xMin = Math.min(...blk.map(b => b.x0))
    const xMax = Math.max(...blk.map(b => b.x0 + b.rows * b.cellW))
    const zMin = Math.min(...blk.map(b => b.z0))
    const zMax = Math.max(...blk.map(b => b.z0 + b.bays * b.cellD))
    const spanX = xMax - xMin
    const spanZ = zMax - zMin
    const cx = (xMin + xMax) / 2
    const cz = (zMin + zMax) / 2
    const fitDist = Math.max(spanX, spanZ) * 0.7
    r.cam = {
      eye: [cx, fitDist * 1.15, cz + fitDist * 0.55],
      target: [cx, 0, cz]
    }
    let handles = buildScene(r, s, geo, [])

    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect()
      const id = r.pick(e.clientX - rect.left, e.clientY - rect.top)
      if (id < 0) return
      if (id < PICK_ENTITY_BASE) {
        const cid = handles.containerPickMap.get(id)
        if (cid) this.pickInfo = { container: s.containers[cid], text: this.containerLines(s.containers[cid]) }
      } else {
        const eid = handles.entityPickMap.get(id)
        if (eid) this.pickInfo = { text: [`设备：${eid}`] }
      }
      const hud = document.getElementById('yard-hud')
      if (hud) { hud.innerHTML = ''; hud.append(...(this.pickInfo?.text.map(t => el('div', {}, t)) ?? this.hudContent().childNodes)) }
    })

    const loop = () => {
      const state = getState()
      handles = buildScene(r, state, currentGeo(), [])
      r.render()
      this.raf = requestAnimationFrame(loop)
    }
    loop()
  }

  private containerLines(c: Container) {
    return [
      `箱号：${c.no}`,
      `类型：${c.kind === 'dg' ? `危险品${c.dgClass}类` : c.kind === 'reefer' ? '冷藏箱' : c.kind === 'empty' ? '空箱' : '普通箱'}`,
      `流向：${c.flow === 'export' ? '出口' : c.flow === 'import' ? '进口' : '中转'}`,
      `目的港：${c.port}`,
      `重量：${c.weight}t（${c.weightClass}）`,
      `箱型：${c.length20 === 1 ? '20尺' : '40尺'}`
    ]
  }

  private hudContent() {
    const s = getState()
    const total = Object.values(s.yard).filter(Boolean).length
    return el('div', {},
      el('b', {}, '堆场概览'),
      el('div', { class: 'muted', style: 'margin-top:6px' }, `在场箱：${fmt(total, 0)} TEU`),
      el('div', { class: 'muted' }, `箱区：${currentGeo().blocks.length} 个`),
      el('div', { class: 'muted', style: 'margin-top:6px;font-size:11px' }, '点击箱子查看箱信息'))
  }

  private blockDetail(b: BlockGeo) {
    const s = getState()
    let count = 0
    const flowCount = { export: 0, import: 0, transit: 0 }
    for (let bay = 0; bay < b.bays; bay++)
      for (let row = 0; row < b.rows; row++)
        for (let tier = 0; tier < b.tiers; tier++) {
          const id = s.yard[slotKey(b.id, bay, row, tier)]
          if (id) {
            count++
            flowCount[s.containers[id].flow]++
          }
        }
    return el('div', {},
      el('div', { class: 'muted' }, `贝位 ${b.bays} × 排 ${b.rows} × 层高 ${b.tiers}`),
      el('div', { style: 'margin-top:6px' },
        el('span', { class: 'badge export' }, `出口 ${flowCount.export}`), ' ',
        el('span', { class: 'badge import' }, `进口 ${flowCount.import}`), ' ',
        el('span', { class: 'badge transit' }, `中转 ${flowCount.transit}`)))
  }

  private pickPanel(b: BlockGeo) {
    const s = getState()
    // 取该箱区当前在场的出口/中转箱（优先提走的箱），演示取箱规划
    const targets: string[] = []
    for (let bay = 0; bay < b.bays && targets.length < 12; bay++)
      for (let row = 0; row < b.rows; row++) {
        const top = (() => {
          for (let tier = b.tiers - 1; tier >= 0; tier--) {
            const id = s.yard[slotKey(b.id, bay, row, tier)]
            if (id) return id
          }
          return null
        })()
        if (top && s.containers[top].flow !== 'import') targets.push(top)
      }
    const plan = optimalPickSequence(s, b, targets.slice(0, 8))
    const totalRehandle = plan.reduce((a, p) => a + p.moves.length, 0)
    return el('div', {},
      el('div', { class: 'flex-between' },
        el('b', {}, `取箱顺序（箱区${b.index + 1}）`),
        select(b.id, currentGeo().blocks.map(x => ({ value: x.id, label: `箱区${x.index + 1}` })),
          id => { this.blockId = id; this.render() })),
      el('div', { class: 'muted mt8', style: 'font-size:11px' },
        `规划 ${plan.length} 个提箱任务，共需翻箱 ${totalRehandle} 次（贪心最小翻箱）`),
      el('div', { class: 'mt8', style: 'max-height:260px;overflow:auto' },
        ...plan.map((step, i) => {
          const c = s.containers[step.containerId]
          return el('div', {
            style: 'padding:6px 8px;border:1px solid var(--line);border-radius:5px;margin-bottom:5px;background:var(--panel2)'
          },
            el('div', {}, `${i + 1}. `, el('span', { style: `color:${containerColorHex(c)}` }, '■'),
              ' ', c.no, ' ', el('span', { class: 'muted', style: 'font-size:11px' }, c.port)),
            step.moves.length
              ? el('div', { class: 'warn-text', style: 'font-size:11px;margin-top:2px' },
                  `需先翻 ${step.moves.length} 箱：${step.moves.map(m => s.containers[m.containerId].no).join(', ')}`)
              : el('div', { class: 'ok-text', style: 'font-size:11px' }, '栈顶可直接提走，零翻箱'))
        }))
    )
  }

  private showPickPlan(b: BlockGeo) {
    this.blockId = b.id
    this.render()
  }

  private kpi(label: string, value: string, sub: string) {
    return el('div', { class: 'kpi' },
      el('div', { class: 'label' }, label),
      el('div', { class: 'value' }, value),
      el('div', { class: 'delta muted' }, sub))
  }

  private bar(pct: number) {
    const color = pct > 85 ? 'var(--alarm)' : pct > 65 ? 'var(--warn)' : 'var(--ok)'
    return el('div', { style: 'display:flex;align-items:center;gap:6px' },
      el('div', { style: 'width:70px;height:8px;background:var(--panel2);border-radius:4px;overflow:hidden' },
        el('div', { style: `width:${Math.min(100, pct)}%;height:100%;background:${color}` })),
      el('span', {}, `${fmt(pct)}%`))
  }
}
