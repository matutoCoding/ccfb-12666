import type { AppState, CraneTask, RoadGraph, SimEntity, SimEvent, ID } from '../types'
import { uid } from '../state/store'
import { shortestPath } from './layout'
import { QC_CYCLE_H, TRUCK_SPEED } from './operations'

interface TruckJob {
  truckId: ID
  path: ID[]
  seg: number
  segLen: number
  taskId: ID
  phase: 'to-crane' | 'to-block' | 'to-gate'
}

/**
 * 固定步长仿真引擎。外部按帧传入仿真时长增量（支持 1x~64x 与快进），
 * 内部一次 step 可消耗任意 dt，保证倍速只改变时钟、不改变结果。
 */
export class SimEngine {
  graph: RoadGraph
  entities: SimEntity[] = []
  private jobs = new Map<ID, TruckJob>()
  private craneWork = new Map<ID, { task: CraneTask; remain: number }>()
  private taskQueue: CraneTask[] = []
  private events: SimEvent[] = []
  queueLengths: Record<ID, number> = {}
  t = 0
  private truckCount: number

  constructor(graph: RoadGraph, craneIds: ID[], truckCount = 24) {
    this.graph = graph
    this.truckCount = truckCount
    const craneNodes = graph.nodes.filter(n => n.kind === 'crane')
    const gate = graph.nodes.find(n => n.kind === 'gate')!
    craneIds.forEach((cid, i) => {
      const n = craneNodes[i % craneNodes.length]
      this.entities.push({ id: cid, kind: 'qc', nodeFrom: n.id, nodeTo: n.id, progress: 0, state: 'idle', x: n.x, z: n.z })
    })
    for (let i = 0; i < truckCount; i++) {
      const n = gate
      this.entities.push({ id: uid('tr'), kind: 'truck', nodeFrom: n.id, nodeTo: n.id, progress: 0, state: 'idle', x: n.x, z: n.z })
    }
    for (const bn of graph.nodes.filter(n => n.kind === 'block')) {
      this.entities.push({ id: uid('yc'), kind: 'yc', nodeFrom: bn.id, nodeTo: bn.id, progress: 0, state: 'idle', x: bn.x, z: bn.z })
    }
  }

  reset(state: AppState) {
    this.t = 0
    this.events = []
    this.jobs.clear()
    this.craneWork.clear()
    this.taskQueue = state.tasks.filter(t => !t.done).sort((a, b) => a.order - b.order)
    for (const e of this.entities) {
      e.state = 'idle'
      e.progress = 0
      const n = this.graph.nodes.find(nn => nn.id === e.nodeFrom)!
      e.nodeTo = e.nodeFrom
      e.x = n.x; e.z = n.z
      if (e.kind === 'truck') e.state = 'idle'
    }
  }

  private log(text: string, level: SimEvent['level'] = 'info') {
    if (this.events.length > 400) this.events.shift()
    this.events.push({ t: this.t, text, level })
  }

  getEventLog() { return this.events }

  /** 推进 dt 仿真小时 */
  step(dt: number, state: AppState) {
    this.t += dt
    const nodeById = new Map(this.graph.nodes.map(n => [n.id, n]))

    // 1. 岸桥：无在干任务则领任务，等待集卡到位后作业
    const qcs = this.entities.filter(e => e.kind === 'qc')
    for (const qc of qcs) {
      if (this.craneWork.has(qc.id)) {
        const w = this.craneWork.get(qc.id)!
        w.remain -= dt
        qc.state = 'working'
        if (w.remain <= 0) {
          const idx = state.tasks.findIndex(t => t.id === w.task.id)
          if (idx >= 0) state.tasks[idx] = { ...state.tasks[idx], done: true }
          this.craneWork.delete(qc.id)
          qc.state = 'idle'
          this.log(`岸桥 ${qc.id.slice(-3)} 完成贝位 ${w.task.bay} 作业`)
        }
      } else {
        const ti = this.taskQueue.findIndex(t => t.craneId === qc.id)
        if (ti >= 0) {
          const task = this.taskQueue.splice(ti, 1)[0]
          // 派一台闲置集卡去对应岸桥节点
          const truck = this.entities.find(e => e.kind === 'truck' && e.state === 'idle')
          const craneNode = this.nearestNode(qc.x, qc.z, 'crane')
          const blockNode = this.graph.nodes.filter(n => n.kind === 'block')[this.hashIdx(task.bay)]
          if (truck && craneNode && blockNode) {
            this.dispatch(truck, craneNode.id, blockNode.id, task.id)
            this.craneWork.set(qc.id, { task, remain: task.durationH + QC_CYCLE_H * 0.5 })
            this.log(`岸桥 ${qc.id.slice(-3)} 开始贝位 ${task.bay}（${task.moveType}）`)
          } else {
            this.taskQueue.unshift(task)   // 无车可用，稍后重试
          }
        }
      }
    }

    // 2. 集卡沿路径行驶
    const arriveCount = new Map<ID, number>()
    for (const e of this.entities) {
      if (e.kind !== 'truck') continue
      const job = this.jobs.get(e.id)
      if (!job) { e.state = 'idle'; continue }
      e.state = 'moving'
      const a = nodeById.get(job.path[job.seg])!
      const b = nodeById.get(job.path[job.seg + 1])!
      const linkLen = job.segLen || b ? Math.hypot(a.x - b.x, a.z - b.z) : 1
      const advance = (TRUCK_SPEED * dt) / Math.max(1, linkLen)
      e.progress += advance
      e.nodeFrom = a.id; e.nodeTo = b.id
      e.x = a.x + (b.x - a.x) * Math.min(1, e.progress)
      e.z = a.z + (b.z - a.z) * Math.min(1, e.progress)
      if (e.progress >= 1) {
        job.seg++
        e.progress = 0
        if (job.seg >= job.path.length - 1) {
          // 到达：到岸桥→等装卸后去箱区；到箱区/闸口→释放
          arriveCount.set(b.id, (arriveCount.get(b.id) ?? 0) + 1)
          if (job.phase === 'to-crane') {
            const blockNode = this.graph.nodes.filter(n => n.kind === 'block')[this.hashIdx(job.taskId.length)]
            const home = this.graph.nodes.find(n => n.kind === 'gate')!
            const next = blockNode ?? home
            const path = shortestPath(this.graph, b.id, next.id)
            if (path.length > 1) {
              this.jobs.set(e.id, { ...job, path, seg: 0, segLen: 0, phase: 'to-block' })
            } else this.release(e)
          } else {
            this.release(e)
          }
        }
      }
    }

    // 3. 场桥：箱区节点有车则进入工作态
    for (const e of this.entities.filter(x => x.kind === 'yc')) {
      const busy = [...this.jobs.values()].some(j => j.phase === 'to-block' && j.path[j.path.length - 1] === e.nodeFrom)
      e.state = busy ? 'working' : 'idle'
    }

    // 4. 排队长度：闸口/交叉口处汇聚的在途车辆
    this.queueLengths = {}
    for (const n of this.graph.nodes.filter(n => n.kind === 'gate' || n.kind === 'junction')) {
      const q = [...this.jobs.values()].filter(j => j.path[j.seg + 1] === n.id).length
      if (q) this.queueLengths[n.id] = q
    }
  }

  private release(e: SimEntity) {
    this.jobs.delete(e.id)
    e.state = 'idle'
    e.progress = 0
  }

  private dispatch(truck: SimEntity, craneNode: ID, blockNode: ID, taskId: ID) {
    const path = shortestPath(this.graph, truck.nodeTo, craneNode)
    if (path.length < 2) return
    this.jobs.set(truck.id, { truckId: truck.id, path, seg: 0, segLen: 0, taskId, phase: 'to-crane' })
    truck.state = 'queueing'
  }

  private nearestNode(x: number, z: number, kind: string) {
    let best: { id: ID; d: number } | null = null
    for (const n of this.graph.nodes) {
      if (n.kind !== kind) continue
      const d = Math.hypot(n.x - x, n.z - z)
      if (!best || d < best.d) best = { id: n.id, d }
    }
    return best ? this.graph.nodes.find(n => n.id === best!.id) : null
  }

  private hashIdx(s: string | number) {
    let h = 0
    const str = String(s)
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0
    return Math.abs(h) % Math.max(1, this.graph.nodes.filter(n => n.kind === 'block').length)
  }

  /** 快进到指定时刻：分块大步长跑，避免逐帧开销 */
  seekTo(target: number, state: AppState, onFrame?: (t: number) => void) {
    this.reset(state)
    const chunk = 0.5
    while (this.t < target) {
      this.step(Math.min(chunk, target - this.t), state)
      if (onFrame && Math.floor(this.t) % 6 === 0) onFrame(this.t)
    }
  }

  stats() {
    const moving = this.entities.filter(e => e.kind === 'truck' && e.state === 'moving').length
    const idle = this.entities.filter(e => e.kind === 'truck' && e.state === 'idle').length
    const workingQc = this.entities.filter(e => e.kind === 'qc' && e.state === 'working').length
    return { moving, idle, workingQc, queueTotal: Object.values(this.queueLengths).reduce((s, v) => s + v, 0) }
  }
}
