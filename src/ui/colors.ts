import type { Container } from '../types'
import { containerColor } from '../gl/scene'

/** 与 WebGL 场景一致的箱色，输出 #hex 供 DOM/Canvas 使用 */
export function containerColorHex(c: Container): string {
  const [r, g, b] = containerColor({ containers: { x: c } } as never, 'x')
  const to = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}
