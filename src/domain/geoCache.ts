import type { LayoutGeo, RoadGraph } from '../types'
import { getState } from '../state/store'
import { buildGeo, buildRoads } from './layout'

// 布局参数变化不频繁，geo 按方案 id 缓存；参数编辑后显式 invalidate
let cached: { id: string; geo: LayoutGeo; roads: RoadGraph } | null = null

export function currentGeo(): LayoutGeo {
  const s = getState()
  const layout = s.layouts.find(l => l.id === s.activeLayoutId) ?? s.layouts[0]
  if (!cached || cached.id !== layout.id) {
    const geo = buildGeo(layout.params)
    const roads = buildRoads(layout.params, geo.berths, geo.blocks, geo.depth)
    cached = { id: layout.id, geo, roads }
  }
  return cached.geo
}

export function currentRoads(): RoadGraph {
  currentGeo()
  return cached!.roads
}

export function invalidateGeo() {
  cached = null
}
