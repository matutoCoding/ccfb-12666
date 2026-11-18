import type { LayoutParams, LayoutGeo, RoadGraph, RoadNode, BlockGeo, BerthGeo, CraneGeo, ID } from '../types'
import { uid } from '../state/store'

/**
 * 平面坐标系：x 沿岸线方向（米），z 向陆侧（纵深，米），岸线 z=0。
 * 2D 平面图与 3D WebGL 共用同一套坐标。
 */
export function buildGeo(p: LayoutParams): LayoutGeo {
  const width = p.shorelineLength
  const depth = p.depth

  // 泊位均分岸线
  const berthW = width / p.berthCount
  const berths: BerthGeo[] = []
  for (let i = 0; i < p.berthCount; i++) {
    const x0 = i * berthW
    const x1 = x0 + berthW
    const bollards = []
    const bollardCount = 6
    for (let k = 0; k < bollardCount; k++) {
      bollards.push({ id: `bol_${i}_${k}`, x: x0 + (berthW * (k + 0.5)) / bollardCount })
    }
    berths.push({ id: `berth_${i}`, index: i, x0, x1, bollards })
  }

  // 岸桥均匀分布在岸线，按位置归属最近泊位
  const cranes: CraneGeo[] = []
  const margin = p.craneSpacing / 2
  for (let i = 0; i < p.craneCount; i++) {
    const x = p.craneCount === 1 ? width / 2 : margin + (i * (width - 2 * margin)) / (p.craneCount - 1)
    const berthIndex = Math.min(p.berthCount - 1, Math.floor(x / berthW))
    cranes.push({ id: `qc_${i}`, index: i, x, berthIndex })
  }

  // 堆场箱区：沿岸线均排 blockRows 个；纵向拉伸铺满前沿与后方干道之间的可用纵深
  const gap = p.rowWidth
  const blockW = (width - gap * (p.blockRows + 1)) / p.blockRows
  const cellW = 6.5
  const cellD = 2.6
  const z0 = p.setback + p.laneWidth * 2
  const rearRoad = p.laneWidth * 2
  const availableDepth = Math.max(60, depth - z0 - rearRoad)
  const blockDepth = availableDepth
  const cellDFit = blockDepth / p.blockBays
  const blocks: BlockGeo[] = []
  for (let i = 0; i < p.blockRows; i++) {
    blocks.push({
      id: `blk_${i}`,
      index: i,
      x0: gap + i * (blockW + gap),
      z0,
      bays: p.blockBays,
      rows: Math.max(2, Math.floor(blockW / cellW)),
      tiers: p.blockTiers,
      cellW,
      cellD: cellDFit
    })
  }

  const roads = buildRoads(p, berths, blocks, depth)
  return { width, depth, berths, cranes, blocks, roads: roads.links, laneWidth: p.laneWidth }
}

export function buildRoads(p: LayoutParams, berths: BerthGeo[], blocks: BlockGeo[], depth: number): RoadGraph {
  const nodes: RoadNode[] = []
  const links: RoadGraph['links'] = []
  const addNode = (n: RoadNode) => { nodes.push(n); return n.id }
  const link = (a: ID, b: ID) => {
    const na = nodes.find(n => n.id === a)!
    const nb = nodes.find(n => n.id === b)!
    const length = Math.hypot(na.x - nb.x, na.z - nb.z)
    links.push({ id: uid('rd'), from: a, to: b, length })
  }

  // 岸桥前沿节点（z=laneWidth）
  const qcNodes: ID[] = berths.flatMap(b => {
    const mid = (b.x0 + b.x1) / 2
    return [addNode({ id: uid('n'), x: b.x0 + (b.x1 - b.x0) * 0.25, z: p.laneWidth, kind: 'crane' }),
            addNode({ id: uid('n'), x: mid, z: p.laneWidth, kind: 'crane' }),
            addNode({ id: uid('n'), x: b.x0 + (b.x1 - b.x0) * 0.75, z: p.laneWidth, kind: 'crane' })]
  })
  // 前沿主干道（双向，用两条逻辑边表示）
  for (let i = 0; i < qcNodes.length - 1; i++) { link(qcNodes[i], qcNodes[i + 1]); link(qcNodes[i + 1], qcNodes[i]) }

  // 箱区节点 + 闸口
  const blockNodes: ID[] = blocks.map(b =>
    addNode({ id: uid('n'), x: b.x0 + (b.rows * b.cellW) / 2, z: b.z0 + b.bays * b.cellD + p.laneWidth, kind: 'block' }))
  const gateX = p.shorelineLength / 2
  const gate = addNode({ id: 'gate_main', x: gateX, z: depth - p.laneWidth, kind: 'gate' })

  // 后方主干道
  const backJunction: ID[] = []
  for (let i = 0; i < blocks.length; i++) {
    const j = addNode({ id: uid('n'), x: blockNodeX(blocks, i), z: depth - p.laneWidth * 2, kind: 'junction' })
    backJunction.push(j)
    link(j, blockNodes[i]); link(blockNodes[i], j)
  }
  for (let i = 0; i < backJunction.length - 1; i++) {
    link(backJunction[i], backJunction[i + 1]); link(backJunction[i + 1], backJunction[i])
  }
  link(gate, backJunction[Math.floor(backJunction.length / 2)])
  link(backJunction[Math.floor(backJunction.length / 2)], gate)

  // 前后主干道之间的纵向连接（每个泊位一根）
  berths.forEach((b, i) => {
    const front = qcNodes[i * 3 + 1]
    const back = backJunction[Math.min(backJunction.length - 1, Math.floor((i + 0.5) / berths.length * blocks.length))]
    link(front, back); link(back, front)
  })

  const adj = new Map<ID, { id: ID; to: ID; length: number }[]>()
  for (const n of nodes) adj.set(n.id, [])
  for (const l of links) adj.get(l.from)!.push({ id: l.id, to: l.to, length: l.length })
  return { nodes, links, adj }
}

function blockNodeX(blocks: BlockGeo[], i: number): number {
  const b = blocks[i]
  return b.x0 + (b.rows * b.cellW) / 2
}

/** Dijkstra 最短路，集卡路径规划用 */
export function shortestPath(g: RoadGraph, from: ID, to: ID): ID[] {
  const dist = new Map<ID, number>()
  const prev = new Map<ID, ID>()
  const visited = new Set<ID>()
  g.nodes.forEach(n => dist.set(n.id, Infinity))
  dist.set(from, 0)
  while (true) {
    let cur: ID | null = null
    let best = Infinity
    for (const [id, d] of dist) {
      if (!visited.has(id) && d < best) { best = d; cur = id }
    }
    if (cur === null) break
    if (cur === to) break
    visited.add(cur)
    for (const e of g.adj.get(cur) ?? []) {
      const nd = best + e.length
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd)
        prev.set(e.to, cur)
      }
    }
  }
  if (!prev.has(to) && from !== to) return []
  const path: ID[] = [to]
  while (path[0] !== from) {
    const p = prev.get(path[0])
    if (!p) return []
    path.unshift(p)
  }
  return path
}
