import type { SimEntity } from '../../types'
import { getState, setState, subscribe } from '../../state/store'
import { currentGeo, currentRoads } from '../../domain/geoCache'
import { SimEngine } from '../../domain/simulation'
import { InstancedRenderer } from '../../gl/renderer'
import { buildScene, PICK_ENTITY_BASE } from '../../gl/scene'
import { el, mount, button, fmt, fmtHour } from '../dom'

export class SimulationPage {
  private unsub: () => void
  private renderer: InstancedRenderer | null = null
  private engine: SimEngine | null = null
  private raf = 0
  private last = 0
  private running = false
  private speed = 8
  private overlay: HTMLDivElement
  private logEl: HTMLDivElement

  constructor(private host: HTMLElement) {
    this.unsub = subscribe(() => this.updateHud())
    this.overlay = el('div', {}) as HTMLDivElement
    this.logEl = el('div', { class: 'event-log' }) as HTMLDivElement
    this.render()
  }

  destroy() {
    this.unsub()
    cancelAnimationFrame(this.raf)
    this.running = false
    this.renderer = null
  }

  private render() {
    const s = getState()
    const geo = currentGeo()
    const canvas = el('canvas', { class: 'scene' }) as HTMLCanvasElement

    const speedBtns = s.sim.speedOptions.map(sp => button(`${sp}x`, () => {
      this.speed = sp
      setState(d => { d.sim.speed = sp })
      this.markActiveSpeed()
    }, 'btn sm speed-btn' + (sp === this.speed ? ' primary' : '')))

    const left = el('div', { class: 'card' },
      el('h3', {}, '作业仿真三维场景',
        el('span', { class: 'tag' }, '岸桥/场桥/集卡按作业计划联动')),
      el('div', { class: 'canvas-wrap', style: 'position:relative' }, canvas,
        el('div', { class: 'overlay-hud', id: 'sim-hud' }),
        this.overlay)
    )

    const right = el('div', { class: 'card scroll-y' },
      el('h3', {}, '播放控制'),
      el('div', { class: 'btn-row' },
        button('▶ 开始', () => this.start(), 'btn primary'),
        button('⏸ 暂停', () => this.pause()),
        button('⏮ 复位', () => this.resetSim())),
      el('h3', { class: 'mt16' }, '倍速'),
      el('div', { class: 'btn-row', id: 'speed-row' }, ...speedBtns),
      el('h3', { class: 'mt16' }, '快进到指定时刻'),
      this.seekControl(),
      el('h3', { class: 'mt16' }, '实时统计'),
      el('div', { id: 'sim-stats', style: 'font-size:12px;line-height:1.9' }),
      el('h3', { class: 'mt16' }, '事件日志'),
      this.logEl
    )

    mount(this.host, el('div', { class: 'grid2', style: 'grid-template-columns:1fr 340px;height:calc(100vh - 110px)' }, left, right))
    this.initGl(canvas)
    this.updateHud()
  }

  private seekControl() {
    const input = el('input', { type: 'number', value: 24, min: 1, max: 168, style: 'width:90px' }) as HTMLInputElement
    return el('div', { class: 'btn-row' },
      el('span', { class: 'muted' }, '仿真小时'),
      input,
      button('快进', () => {
        const target = parseFloat(input.value) || 24
        this.pause()
        const state = getState()
        this.engine!.seekTo(target, state, () => this.paint())
        setState(d => { d.sim.t = this.engine!.t })
        this.paint()
        this.updateHud()
      }))
  }

  private initGl(canvas: HTMLCanvasElement) {
    const r = new InstancedRenderer(canvas)
    this.renderer = r
    r.attachControls()
    const geo = currentGeo()
    const blk = geo.blocks
    const xMin = Math.min(...blk.map(b => b.x0))
    const xMax = Math.max(...blk.map(b => b.x0 + b.rows * b.cellW))
    const zMin = Math.min(...blk.map(b => b.z0))
    const zMax = Math.max(...blk.map(b => b.z0 + b.bays * b.cellD))
    const cx = (xMin + xMax) / 2
    const cz = (zMin + zMax) / 2
    const fitDist = Math.max(xMax - xMin, zMax - zMin) * 0.7
    r.cam = {
      eye: [cx, fitDist * 1.15, cz + fitDist * 0.55],
      target: [cx, 0, cz]
    }

    this.engine = new SimEngine(currentRoads(), geo.cranes.map(c => c.id), 26)
    this.engine.reset(getState())

    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect()
      const id = r.pick(e.clientX - rect.left, e.clientY - rect.top)
      if (id >= PICK_ENTITY_BASE) {
        const eid = this.engine!.entities.find((_, i) => PICK_ENTITY_BASE + 200 + i === id)?.id
        if (eid) console.log('选中设备', eid)
      }
    })

    const loop = (now: number) => {
      if (!this.renderer) return
      if (!this.last) this.last = now
      const realDt = Math.min(0.1, (now - this.last) / 1000)
      this.last = now
      if (this.running && this.engine) {
        // 时间尺度：1x = 1 仿真小时/真实秒，倍速档位线性放大；分块推进避免集卡跳变
        const simDt = realDt * this.speed
        let remain = simDt
        const state = getState()
        while (remain > 0) {
          const chunk = Math.min(0.2, remain)
          this.engine.step(chunk, state)
          remain -= chunk
        }
        setState(d => {
          d.sim.t = this.engine!.t
          d.sim.events = this.engine!.getEventLog().slice(-80)
          d.sim.queueLengths = { ...this.engine!.queueLengths }
        })
      }
      this.paint()
      this.updateHud()
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  private paint() {
    if (!this.renderer || !this.engine) return
    const r = this.renderer
    const moving: SimEntity[] = this.engine.entities
    buildScene(r, getState(), currentGeo(), moving)
    r.render()
    this.drawQueueOverlay()
  }

  private drawQueueOverlay() {
    const geo = currentGeo()
    const roads = currentRoads()
    const ql = this.engine?.queueLengths ?? {}
    const cv = this.renderer ? (this.renderer as unknown as { canvas: HTMLCanvasElement }).canvas : null
    if (!cv) return
    const items = roads.nodes.filter(n => ql[n.id]).map(n => {
      const sx = (n.x / geo.width) * cv.clientWidth
      const sy = (n.z / geo.depth) * cv.clientHeight
      return el('div', { class: 'queue-pill', style: `left:${sx}px;top:${sy}px` }, `排队 ${ql[n.id]}`)
    })
    this.overlay.innerHTML = ''
    this.overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none'
    this.overlay.append(...items)
  }

  private start() {
    if (!this.engine) return
    this.running = true
    setState(d => { d.sim.running = true })
  }
  private pause() {
    this.running = false
    setState(d => { d.sim.running = false })
  }
  private resetSim() {
    this.pause()
    const s = getState()
    s.tasks.forEach(t => (t.done = false))
    this.engine?.reset(s)
    setState(d => {
      d.sim.t = 0
      d.sim.events = []
      d.sim.queueLengths = {}
      d.tasks.forEach(t => (t.done = false))
    })
    this.paint()
  }

  private markActiveSpeed() {
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('primary'))
  }

  private updateHud() {
    const hud = document.getElementById('sim-hud')
    const stats = document.getElementById('sim-stats')
    if (!this.engine) return
    const st = this.engine.stats()
    const done = getState().tasks.filter(t => t.done).length
    if (hud) {
      hud.innerHTML = ''
      hud.append(
        el('b', {}, `仿真时刻 ${fmtHour(this.engine.t)}`),
        el('div', { class: 'muted', style: 'margin-top:4px' }, `t = ${fmt(this.engine.t, 1)} h · 倍速 ${this.speed}x`),
        el('div', { style: 'margin-top:6px' }, `任务完成 ${done}/${getState().tasks.length}`),
        el('div', {}, `工作岸桥 ${st.workingQc} 台`),
        el('div', {}, `在途集卡 ${st.moving} · 闲置 ${st.idle}`),
        el('div', { class: st.queueTotal > 6 ? 'alarm-text' : '' }, `排队车辆合计 ${st.queueTotal}`))
    }
    if (stats) {
      stats.innerHTML = ''
      const qcs = this.engine.entities.filter(e => e.kind === 'qc')
      stats.append(
        el('div', {}, `岸桥总数：${qcs.length}，工作中：${st.workingQc}`),
        el('div', {}, `集卡总数：${this.engine.entities.filter(e => e.kind === 'truck').length}`),
        el('div', {}, `场桥总数：${this.engine.entities.filter(e => e.kind === 'yc').length}`),
        el('div', {}, `道路节点：${currentRoads().nodes.length}，路段：${currentRoads().links.length}`),
        el('div', { class: 'muted mt8' }, `渲染实例数（含万箱）由 GPU 实例化单次绘制`))
    }
    const events = this.engine.getEventLog().slice(-30).reverse()
    if (this.logEl && events.length) {
      this.logEl.innerHTML = ''
      this.logEl.append(...events.map(ev => el('div', { class: 'e ' + ev.level },
        el('span', { class: 't' }, `t${fmt(ev.t, 0)}h`), ev.text)))
    }
  }
}
