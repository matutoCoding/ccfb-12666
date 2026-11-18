import type { LayoutParams, LayoutScheme } from '../../types'
import { getState, setState, subscribe, uid } from '../../state/store'
import { currentGeo, invalidateGeo } from '../../domain/geoCache'
import { el, mount, labeled, numInput, button, fmt } from '../dom'

export class LayoutPage {
  private unsub: () => void
  private canvas: HTMLCanvasElement
  private ro: ResizeObserver

  constructor(private host: HTMLElement) {
    this.canvas = el('canvas', { class: 'scene' }) as HTMLCanvasElement
    this.ro = new ResizeObserver(() => this.draw())
    this.ro.observe(this.canvas)
    this.unsub = subscribe(() => this.draw())
    this.render()
    this.draw()
  }

  destroy() { this.unsub(); this.ro.disconnect() }

  private active(): LayoutScheme {
    const s = getState()
    return s.layouts.find(l => l.id === s.activeLayoutId) ?? s.layouts[0]
  }

  private render() {
    const s = getState()
    const scheme = this.active()
    const p = scheme.params

    const paramFields = (Object.keys(p) as (keyof LayoutParams)[]).map(k => {
      const labels: Record<keyof LayoutParams, string> = {
        shorelineLength: '岸线长度 (m)', berthCount: '泊位数', craneCount: '岸桥数量',
        craneSpacing: '岸桥间距 (m)', blockRows: '箱区数(行)', blockBays: '每箱区贝位数(列)',
        blockTiers: '堆高层数', laneWidth: '车道宽度 (m)', depth: '码头纵深 (m)',
        setback: '前沿距离 (m)', rowWidth: '箱区间通道 (m)'
      }
      const integer = !['shorelineLength', 'craneSpacing', 'laneWidth', 'depth', 'setback', 'rowWidth'].includes(k)
      return labeled(labels[k], numInput(p[k], v => {
        invalidateGeo()
        setState(d => {
          const lay = d.layouts.find(l => l.id === d.activeLayoutId)!
          ;(lay.params as unknown as Record<string, number>)[k] = integer ? Math.max(1, Math.round(v)) : Math.max(1, v)
          lay.updatedAt = Date.now()
        })
      }, integer ? 1 : 0.5, 1))
    })

    const schemeList = el('div', {},
      ...s.layouts.map(l => el('div', {
        class: 'scheme-item' + (l.id === scheme.id ? ' active' : ''),
        onclick: () => { invalidateGeo(); setState(d => { d.activeLayoutId = l.id }) }
      },
        el('div', {}, el('div', {}, l.name), el('div', { class: 'muted', style: 'font-size:11px' },
          `${l.params.berthCount}泊位 · ${l.params.craneCount}岸桥 · ${l.params.blockRows}箱区`)),
        button('复制', () => {
          invalidateGeo()
          setState(d => {
            d.layouts.push({ id: uid('layout'), name: l.name + ' 副本', params: { ...l.params }, updatedAt: Date.now() })
          })
        }, 'btn sm')
      )),
      el('div', { class: 'btn-row' },
        button('新建布局方案', () => {
          invalidateGeo()
          setState(d => {
            const id = uid('layout')
            d.layouts.push({ id, name: `自定义方案 ${d.layouts.length + 1}`, params: { ...d.layouts[0].params }, updatedAt: Date.now() })
            d.activeLayoutId = id
          })
        }),
        button('删除当前方案', () => {
          if (s.layouts.length <= 1) return alert('至少保留一套方案')
          setState(d => {
            d.layouts = d.layouts.filter(l => l.id !== d.activeLayoutId)
            d.activeLayoutId = d.layouts[0].id
            invalidateGeo()
          })
        }, 'btn danger')
      )
    )

    const geo = currentGeo()
    const stats = el('div', { class: 'mt16' },
      el('h3', {}, '几何核算'),
      el('table', {},
        el('tbody', {},
          statRow('泊位平均长度', `${fmt(geo.width / geo.berths.length)} m`),
          statRow('岸桥总台数', `${geo.cranes.length} 台`),
          statRow('堆场箱区数', `${geo.blocks.length} 个`),
          statRow('单箱区容量', `${fmt((geo.blocks[0] ? geo.blocks[0].bays * geo.blocks[0].rows * geo.blocks[0].tiers : 0))} TEU`),
          statRow('堆场总容量', `${fmt(geo.blocks.reduce((sum, b) => sum + b.bays * b.rows * b.tiers, 0))} TEU`),
          statRow('道路节点/边', `${geo.roads.length + 1} / ${geo.roads.length}`)
        )
      )
    )

    const left = el('div', { class: 'card' },
      el('h3', {}, '布局方案', el('span', { class: 'tag' }, `${s.layouts.length} 套可切换`)),
      schemeList,
      el('h3', { class: 'mt16' }, '参数（改完自动重排平面图）'),
      ...paramFields,
      stats
    )

    const right = el('div', { class: 'card' },
      el('h3', {}, '平面布置图', el('span', { class: 'tag' }, '上=海侧 下=陆侧 · 蓝条泊位/橙点岸桥/棕块箱区')),
      el('div', { class: 'canvas-wrap' }, this.canvas)
    )

    mount(this.host, el('div', { class: 'grid2', style: 'grid-template-columns:340px 1fr' }, left, right))
  }

  private draw() {
    const cv = this.canvas
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = cv.clientWidth, h = cv.clientHeight
    if (!w || !h) return
    cv.width = w * dpr; cv.height = h * dpr
    const ctx = cv.getContext('2d')!
    ctx.scale(dpr, dpr)
    const geo = currentGeo()
    const sx = (w - 40) / geo.width
    const sy = (h - 60) / geo.depth
    const scale = Math.min(sx, sy)
    const ox = 20, oy = 30
    const X = (x: number) => ox + x * scale
    const Z = (z: number) => oy + z * scale

    ctx.fillStyle = '#0b0f14'
    ctx.fillRect(0, 0, w, h)

    // 水域
    ctx.fillStyle = '#0d2330'
    ctx.fillRect(ox, oy - 18, geo.width * scale, 18)
    // 陆域
    ctx.fillStyle = '#151b24'
    ctx.fillRect(ox, oy, geo.width * scale, geo.depth * scale)

    // 泊位
    for (const b of geo.berths) {
      ctx.fillStyle = '#26324a'
      ctx.fillRect(X(b.x0), Z(0), (b.x1 - b.x0) * scale - 2, 26)
      ctx.strokeStyle = '#3a4c6e'
      ctx.strokeRect(X(b.x0), Z(0), (b.x1 - b.x0) * scale - 2, 26)
      ctx.fillStyle = '#8fb4e8'
      ctx.font = '11px sans-serif'
      ctx.fillText(`泊位 ${b.index + 1}`, X(b.x0) + 6, Z(0) + 17)
      // 系船柱
      for (const bol of b.bollards) {
        ctx.fillStyle = '#c9d4e3'
        ctx.fillRect(X(bol.x) - 2, Z(0) + 22, 4, 4)
      }
    }

    // 道路
    ctx.strokeStyle = '#2c333d'
    ctx.lineWidth = Math.max(2, geo.laneWidth * scale * 0.6)
    ctx.beginPath()
    ctx.moveTo(X(0), Z(geo.laneWidth))
    ctx.lineTo(X(geo.width), Z(geo.laneWidth))
    ctx.moveTo(X(0), Z(geo.depth - geo.laneWidth))
    ctx.lineTo(X(geo.width), Z(geo.depth - geo.laneWidth))
    ctx.stroke()
    ctx.lineWidth = 1

    // 箱区
    for (const blk of geo.blocks) {
      const bw = blk.rows * blk.cellW * scale
      const bd = blk.bays * blk.cellD * scale
      ctx.fillStyle = '#4a3f2c'
      ctx.fillRect(X(blk.x0), Z(blk.z0), bw, bd)
      ctx.strokeStyle = '#6b5a3c'
      ctx.strokeRect(X(blk.x0), Z(blk.z0), bw, bd)
      ctx.fillStyle = '#a98f5e'
      ctx.font = '10px sans-serif'
      ctx.fillText(`箱区${blk.index + 1}`, X(blk.x0) + 4, Z(blk.z0) + 12)
      // 贝位分隔线
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'
      for (let bay = 1; bay < blk.bays; bay++) {
        ctx.beginPath()
        ctx.moveTo(X(blk.x0), Z(blk.z0 + bay * blk.cellD))
        ctx.lineTo(X(blk.x0) + bw, Z(blk.z0 + bay * blk.cellD))
        ctx.stroke()
      }
    }

    // 岸桥
    for (const c of geo.cranes) {
      ctx.fillStyle = '#f29e38'
      ctx.beginPath()
      ctx.arc(X(c.x), Z(0) + 8, 5, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#f29e38'
      ctx.fillRect(X(c.x) - 1.5, Z(0) - 14, 3, 22)
      ctx.fillStyle = '#ffd9a8'
      ctx.font = '9px sans-serif'
      ctx.fillText(`QC${c.index + 1}`, X(c.x) - 8, Z(0) - 18)
    }

    // 闸口
    ctx.fillStyle = '#8b5cf6'
    ctx.fillRect(X(geo.width / 2) - 18, Z(geo.depth) - 6, 36, 6)
    ctx.fillStyle = '#c4b5fd'
    ctx.font = '10px sans-serif'
    ctx.fillText('闸口', X(geo.width / 2) - 10, Z(geo.depth) - 10)

    // 比例尺
    ctx.strokeStyle = '#7d8ba0'
    ctx.beginPath()
    ctx.moveTo(ox, h - 14); ctx.lineTo(ox + 100 * scale, h - 14)
    ctx.stroke()
    ctx.fillStyle = '#7d8ba0'
    ctx.font = '10px sans-serif'
    ctx.fillText('100 m', ox + 100 * scale / 2 - 14, h - 18)
  }
}

function statRow(label: string, value: string) {
  return el('tr', {}, el('td', { class: 'muted' }, label), el('td', { style: 'text-align:right;font-weight:600' }, value))
}
