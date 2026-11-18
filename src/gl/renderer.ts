export function createProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc)
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc)
  const p = gl.createProgram()!
  gl.attachShader(p, vs)
  gl.attachShader(p, fs)
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('Program 链接失败: ' + gl.getProgramInfoLog(p))
  }
  return p
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('Shader 编译失败: ' + gl.getShaderInfoLog(s))
  }
  return s
}

export interface Camera {
  eye: [number, number, number]
  target: [number, number, number]
}

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in mat4 aInstance;      // 实例矩阵
layout(location=6) in vec4 aColor;        // rgb + 类别 alpha
layout(location=7) in float aPickId;      // 拾取 id（-1 表示不拾取）
uniform mat4 uViewProj;
out vec3 vNormal;
out vec4 vColor;
out float vPick;
void main() {
  vec4 world = aInstance * vec4(aPos, 1.0);
  gl_Position = uViewProj * world;
  vNormal = mat3(aInstance) * aNormal;
  vColor = aColor;
  vPick = aPickId;
}`

const FRAG = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec4 vColor;
in float vPick;
uniform int uPickMode;
uniform float uHighlight;
out vec4 outColor;
void main() {
  if (uPickMode == 1) {
    // 拾取：把 id 编码成颜色
    int id = int(vPick + 0.5);
    float r = float((id >> 16) & 255) / 255.0;
    float g = float((id >> 8) & 255) / 255.0;
    float b = float(id & 255) / 255.0;
    outColor = vec4(r, g, b, 1.0);
    return;
  }
  vec3 n = normalize(vNormal);
  float light = 0.55 + 0.45 * max(dot(n, normalize(vec3(0.4, 0.9, 0.3))), 0.0);
  vec3 col = vColor.rgb * light + vec3(uHighlight);
  outColor = vec4(col, vColor.a);
}`

export interface Instance {
  matrix: Float32Array   // 16
  color: [number, number, number, number]
  pickId: number         // -1 = 不参与拾取
}

function mat4TranslateScale(tx: number, ty: number, tz: number, sx: number, sy: number, sz: number): Float32Array {
  return new Float32Array([
    sx, 0, 0, 0,
    0, sy, 0, 0,
    0, 0, sz, 0,
    tx, ty, tz, 1
  ])
}

export class InstancedRenderer {
  gl: WebGL2RenderingContext
  private program: WebGLProgram
  private vao: WebGLVertexArrayObject
  private cubeVbo: WebGLBuffer
  private instanceVbo: WebGLBuffer
  private colorVbo: WebGLBuffer
  private pickVbo: WebGLBuffer
  private uViewProj: WebGLUniformLocation
  private uPickMode: WebGLUniformLocation
  private uHighlight: WebGLUniformLocation
  private capacity = 70000
  private instances: Instance[] = []
  private pickFramebuffer: WebGLFramebuffer | null = null
  private pickTexture: WebGLTexture | null = null
  cam: Camera = { eye: [900, 750, 900], target: [600, 0, 300] }
  highlightId = -1
  private canvas: HTMLCanvasElement

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false })
    if (!gl) throw new Error('当前浏览器不支持 WebGL2')
    this.gl = gl
    this.canvas = canvas
    this.program = createProgram(gl, VERT, FRAG)
    this.uViewProj = gl.getUniformLocation(this.program, 'uViewProj')!
    this.uPickMode = gl.getUniformLocation(this.program, 'uPickMode')!
    this.uHighlight = gl.getUniformLocation(this.program, 'uHighlight')!

    this.vao = gl.createVertexArray()!
    gl.bindVertexArray(this.vao)
    this.cubeVbo = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cubeVbo)
    gl.bufferData(gl.ARRAY_BUFFER, cubeData(), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12)

    this.instanceVbo = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVbo)
    gl.bufferData(gl.ARRAY_BUFFER, this.capacity * 64, gl.DYNAMIC_DRAW)
    for (let i = 0; i < 4; i++) {
      const loc = 2 + i
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 64, i * 16)
      gl.vertexAttribDivisor(loc, 1)
    }
    this.colorVbo = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorVbo)
    gl.bufferData(gl.ARRAY_BUFFER, this.capacity * 16, gl.DYNAMIC_DRAW)
    gl.enableVertexAttribArray(6)
    gl.vertexAttribPointer(6, 4, gl.FLOAT, false, 16, 0)
    gl.vertexAttribDivisor(6, 1)

    this.pickVbo = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pickVbo)
    gl.bufferData(gl.ARRAY_BUFFER, this.capacity * 4, gl.DYNAMIC_DRAW)
    gl.enableVertexAttribArray(7)
    gl.vertexAttribPointer(7, 1, gl.FLOAT, false, 4, 0)
    gl.vertexAttribDivisor(7, 1)
    gl.bindVertexArray(null)
    gl.enable(gl.DEPTH_TEST)
    gl.enable(gl.CULL_FACE)
  }

  reset() { this.instances = [] }

  addBox(tx: number, ty: number, tz: number, sx: number, sy: number, sz: number,
         color: Instance['color'], pickId = -1) {
    if (this.instances.length >= this.capacity) return
    this.instances.push({ matrix: mat4TranslateScale(tx, ty, tz, sx, sy, sz), color, pickId })
  }

  /** 每帧上传全部实例并一次 draw call 绘制（万箱级） */
  render() {
    const gl = this.gl
    this.resize()
    gl.clearColor(0.07, 0.09, 0.12, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    if (!this.instances.length) return
    gl.useProgram(this.program)
    const aspect = this.canvas.width / Math.max(1, this.canvas.height)
    gl.uniformMatrix4fv(this.uViewProj, false, viewProj(this.cam, aspect))
    gl.uniform1i(this.uPickMode, 0)
    gl.uniform1f(this.uHighlight, 0)

    gl.bindVertexArray(this.vao)
    const n = this.instances.length
    const matData = new Float32Array(n * 16)
    const colData = new Float32Array(n * 4)
    const pickData = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      matData.set(this.instances[i].matrix, i * 16)
      colData.set(this.instances[i].color, i * 4)
      pickData[i] = this.instances[i].pickId
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVbo)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, matData)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorVbo)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, colData)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pickVbo)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, pickData)
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, n)
    gl.bindVertexArray(null)
  }

  /** 离屏拾取：返回屏幕坐标处的 pickId */
  pick(cssX: number, cssY: number): number {
    const gl = this.gl
    if (!this.instances.length) return -1
    this.ensurePickTarget()
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFramebuffer)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.useProgram(this.program)
    const aspect = this.canvas.width / Math.max(1, this.canvas.height)
    gl.uniformMatrix4fv(this.uViewProj, false, viewProj(this.cam, aspect))
    gl.uniform1i(this.uPickMode, 1)
    gl.bindVertexArray(this.vao)
    const n = this.instances.length
    const pickData = new Float32Array(this.instances.map(i => i.pickId < 0 ? 16777215 : i.pickId))
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pickVbo)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, pickData)
    // matrix/color 仍需绑定（render 中已上传，VAO 持久）
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, n)
    const px = Math.floor(cssX * (this.canvas.width / this.canvas.clientWidth))
    const py = Math.floor((this.canvas.clientHeight - cssY) * (this.canvas.height / this.canvas.clientHeight))
    const buf = new Uint8Array(4)
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    const id = buf[0] * 65536 + buf[1] * 256 + buf[2]
    return id === 16777215 ? -1 : id
  }

  private ensurePickTarget() {
    const gl = this.gl
    if (this.pickFramebuffer) return
    this.pickFramebuffer = gl.createFramebuffer()
    this.pickTexture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.pickTexture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.canvas.width, this.canvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    const depth = gl.createRenderbuffer()
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth)
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, this.canvas.width, this.canvas.height)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFramebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickTexture, 0)
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  private resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = Math.floor(this.canvas.clientWidth * dpr)
    const h = Math.floor(this.canvas.clientHeight * dpr)
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
      this.pickFramebuffer = null   // 尺寸变化后重建拾取目标
    }
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height)
  }

  /** 调试用：读取屏幕像素（renderer 自身 gl 上下文） */
  debugPixel(x: number, y: number): number[] {
    const gl = this.gl
    const buf = new Uint8Array(4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    return [...buf]
  }

  debugInstanceCount(): number { return this.instances.length }

  /** 轨道相机控制（左键旋转、右键平移、滚轮缩放） */
  attachControls() {
    const c = this.canvas
    let dragging: 'rotate' | 'pan' | null = null
    let lx = 0, ly = 0
    c.addEventListener('contextmenu', e => e.preventDefault())
    c.addEventListener('pointerdown', e => {
      dragging = e.button === 2 ? 'pan' : 'rotate'
      lx = e.clientX; ly = e.clientY
      c.setPointerCapture(e.pointerId)
    })
    c.addEventListener('pointerup', () => { dragging = null })
    c.addEventListener('pointermove', e => {
      if (!dragging) return
      const dx = e.clientX - lx, dy = e.clientY - ly
      lx = e.clientX; ly = e.clientY
      if (dragging === 'rotate') {
        let ang = Math.atan2(this.cam.eye[0] - this.cam.target[0], this.cam.eye[2] - this.cam.target[2])
        ang += dx * 0.006
        this.cam.eye[1] = Math.max(40, Math.min(2000, this.cam.eye[1] - dy * 2.2))
        const horiz = Math.max(50, Math.hypot(this.cam.eye[0] - this.cam.target[0], this.cam.eye[2] - this.cam.target[2]))
        this.cam.eye[0] = this.cam.target[0] + Math.sin(ang) * horiz
        this.cam.eye[2] = this.cam.target[2] + Math.cos(ang) * horiz
      } else {
        this.cam.target[0] += dx * 1.2
        this.cam.target[2] += dy * 1.2
      }
    })
    c.addEventListener('wheel', e => {
      e.preventDefault()
      const f = e.deltaY > 0 ? 1.08 : 0.92
      this.cam.eye = [
        this.cam.target[0] + (this.cam.eye[0] - this.cam.target[0]) * f,
        Math.max(40, this.cam.eye[1] * f),
        this.cam.target[2] + (this.cam.eye[2] - this.cam.target[2]) * f
      ]
    }, { passive: false })
  }
}

export function viewProj(cam: Camera, aspect: number): Float32Array {
  const fov = (50 * Math.PI) / 180
  const near = 1, far = 8000
  const f = 1 / Math.tan(fov / 2)
  const [ex, ey, ez] = cam.eye
  const [tx, ty, tz] = cam.target
  const fx = tx - ex, fy = ty - ey, fz = tz - ez
  const len = Math.hypot(fx, fy, fz)
  const zx = fx / len, zy = fy / len, zz = fz / len
  const xx = zy * 0 - zz * 0 + 0   // 上向量 (0,1,0) 叉乘
  let rx = zy * 0 - zz * 1
  let ry = zz * 0 - zx * 0
  let rz = zx * 1 - zy * 0
  const rl = Math.hypot(rx, ry, rz)
  rx /= rl; ry /= rl; rz /= rl
  const ux = ry * zz - rz * zy, uy = rz * zx - rx * zz, uz = rx * zy - ry * zx
  const proj = new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0
  ])
  const view = new Float32Array([
    rx, ux, -zx, 0,
    ry, uy, -zy, 0,
    rz, uz, -zz, 0,
    -(rx * ex + ry * ey + rz * ez),
    -(ux * ex + uy * ey + uz * ez),
    -(-zx * ex + -zy * ey + -zz * ez),
    1
  ])
  return mul4(proj, view)
}

function mul4(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(16)
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++)
      o[c * 4 + r] = a[0 * 4 + r] * b[c * 4 + 0] + a[1 * 4 + r] * b[c * 4 + 1] +
                     a[2 * 4 + r] * b[c * 4 + 2] + a[3 * 4 + r] * b[c * 4 + 3]
  return o
}

/** 单位立方体（边长 2，中心原点），位置/尺寸全部走实例矩阵 */
function cubeData(): Float32Array {
  const faces = [
    [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1], [0, 0, 1]],
    [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1], [0, 0, -1]],
    [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1], [0, 1, 0]],
    [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1], [0, -1, 0]],
    [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1], [1, 0, 0]],
    [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, 0, 0]]
  ]
  const data: number[] = []
  for (const [a, b, c, d, n] of faces) {
    for (const v of [a, b, c, a, c, d]) data.push(...v, ...n)
  }
  return new Float32Array(data)
}
