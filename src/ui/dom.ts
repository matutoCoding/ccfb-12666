// 极简 DOM 构建工具，避免引入框架
export type ElChild = Node | string | null | undefined | false

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | EventListener | undefined> = {},
  ...children: ElChild[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue
    if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener)
    } else if (k === 'value') {
      ;(node as HTMLInputElement).value = String(v)
    } else if (k === 'checked') {
      ;(node as HTMLInputElement).checked = Boolean(v)
    } else {
      node.setAttribute(k, String(v))
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue
    node.append(typeof c === 'string' ? document.createTextNode(c) : c)
  }
  return node
}

export function clear(node: HTMLElement) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

export function mount(parent: HTMLElement, ...children: ElChild[]) {
  clear(parent)
  parent.append(...(children.filter(Boolean) as Node[]))
}

export function labeled(label: string, input: HTMLElement): HTMLElement {
  return el('label', { class: 'field' }, el('span', {}, label), input)
}

export function numInput(value: number, onInput: (v: number) => void, step = 1, min?: number): HTMLInputElement {
  const input = el('input', {
    type: 'number',
    value,
    step,
    ...(min !== undefined ? { min } : {}),
    oninput: () => {
      const v = parseFloat((input as HTMLInputElement).value)
      if (!Number.isNaN(v)) onInput(v)
    }
  }) as HTMLInputElement
  return input
}

export function textInput(value: string, onInput: (v: string) => void): HTMLInputElement {
  return el('input', {
    type: 'text',
    value,
    oninput: (e: Event) => onInput((e.target as HTMLInputElement).value)
  }) as HTMLInputElement
}

export function select<T extends string>(
  value: T,
  options: { value: T; label: string }[],
  onChange: (v: T) => void
): HTMLSelectElement {
  const s = el('select', {
    onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value as T)
  }) as HTMLSelectElement
  for (const o of options) {
    s.append(el('option', { value: o.value, ...(o.value === value ? { selected: true } : {}) }, o.label))
  }
  return s
}

export function button(label: string, onClick: () => void, cls = 'btn'): HTMLButtonElement {
  return el('button', { class: cls, onclick: onClick }, label)
}

export function fmt(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: 0 })
}

export function fmtHour(h: number): string {
  // 仿真零点 = 周一 00:00
  const day = Math.floor(h / 24)
  const hh = Math.floor(h % 24)
  const mm = Math.floor((h % 1) * 60)
  const names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
  return `${names[day % 7]} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

export function download(filename: string, content: string | Blob, mime = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = el('a', { href: url, download: filename }) as HTMLAnchorElement
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}
