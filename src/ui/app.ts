import { el, mount, download } from './dom'
import { getState, resetState, exportState, replaceState } from '../state/store'
import { LayoutPage } from './pages/LayoutPage'
import { BerthPlanPage } from './pages/BerthPlanPage'
import { StowagePage } from './pages/StowagePage'
import { YardPage } from './pages/YardPage'
import { SimulationPage } from './pages/SimulationPage'
import { ReportsPage } from './pages/ReportsPage'

export type PageKey = 'layout' | 'berth' | 'stowage' | 'yard' | 'sim' | 'reports'

const NAV: { key: PageKey; label: string; icon: string }[] = [
  { key: 'layout', label: '码头布局', icon: '▦' },
  { key: 'berth', label: '泊位计划', icon: '⚓' },
  { key: 'stowage', label: '船舶配载', icon: '🚢' },
  { key: 'yard', label: '堆场管理', icon: '📦' },
  { key: 'sim', label: '作业仿真', icon: '▶' },
  { key: 'reports', label: '统计报表', icon: '📊' }
]

const SUBTITLES: Record<PageKey, string> = {
  layout: '多套布局可切换对比，参数改完自动重排平面图',
  berth: '系缆方案 · 缆绳张力校核 · 船期气象预警',
  stowage: '自动配载 · 危品隔离 · 稳性实时校核',
  yard: '三维箱区 · 占用率/翻箱率 · 最优取箱顺序',
  sim: '岸桥/场桥/集卡联动 · 实例化万箱渲染',
  reports: '日报周报 · 环比涨跌 · Excel 导出'
}

/**
 * 静态外壳：导航切换时才重建页面。
 * 不订阅全局状态 —— 仿真每帧 setState 不会导致页面/WebGL 上下文被销毁。
 */
export class App {
  private page: PageKey = 'layout'
  private pageInstance: { destroy?: () => void } | null = null
  private navItems: HTMLElement[] = []
  private title: HTMLElement
  private subtitle: HTMLElement
  private content: HTMLElement

  constructor(private root: HTMLElement) {
    this.subtitle = el('div', { class: 'sub' })
    this.title = el('div', { class: 'title' })
    this.content = el('div', { class: 'content' })
    const nav = el('div', { class: 'sidebar' },
      el('h1', {}, '集装箱码头仿真平台',
        el('small', {}, '纯浏览器 · WebGL2 · TypeScript')),
      ...NAV.map(n => {
        const item = el('div', {
          class: 'nav-item',
          onclick: () => this.navigate(n.key)
        }, el('span', {}, n.icon), el('span', {}, n.label))
        this.navItems.push(item)
        return item
      }),
      el('div', { class: 'spacer' }),
      el('div', { class: 'env-note' },
        el('div', { class: 'btn-row', style: 'flex-direction:column' },
          el('button', { class: 'btn sm', onclick: () => download('terminal-sim-backup.json', exportState(), 'application/json') }, '导出项目 JSON'),
          el('button', { class: 'btn sm', onclick: () => this.importJson() }, '导入项目 JSON'),
          el('button', { class: 'btn sm danger', onclick: () => { if (confirm('确定恢复演示初始数据？当前修改将丢失。')) resetState() } }, '重置演示数据')
        ),
        el('div', { style: 'margin-top:8px' }, `在场箱量 ${Object.keys(getState().containers).length.toLocaleString()} TEU`)
      )
    )
    const top = el('div', { class: 'topbar' },
      this.title,
      this.subtitle
    )
    mount(this.root, nav, el('div', { class: 'main' }, top, this.content))
    this.navigate('layout')
  }

  private navigate(key: PageKey) {
    this.page = key
    this.navItems.forEach((item, i) => item.classList.toggle('active', NAV[i].key === key))
    this.title.textContent = NAV.find(n => n.key === key)!.label
    this.subtitle.textContent = SUBTITLES[key]
    this.pageInstance?.destroy?.()
    mount(this.content)
    this.pageInstance = this.mountPage(this.content, key)
  }

  private mountPage(host: HTMLElement, key: PageKey) {
    switch (key) {
      case 'layout': return new LayoutPage(host)
      case 'berth': return new BerthPlanPage(host)
      case 'stowage': return new StowagePage(host)
      case 'yard': return new YardPage(host)
      case 'sim': return new SimulationPage(host)
      case 'reports': return new ReportsPage(host)
    }
  }

  private importJson() {
    const input = el('input', { type: 'file', accept: '.json', onchange: async () => {
      const f = (input as HTMLInputElement).files?.[0]
      if (!f) return
      try {
        const text = await f.text()
        replaceState(JSON.parse(text))
        alert('导入成功，即将重新加载页面')
        location.reload()
      } catch {
        alert('文件解析失败')
      }
    } }) as HTMLInputElement
    input.click()
  }
}
