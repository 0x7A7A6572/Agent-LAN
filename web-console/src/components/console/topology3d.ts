// 3D 节点拓扑场景：Three.js 舞台，数据由外部灌入
// 关键约束：玻璃/金属必须先有 HDRI 环境，否则显塑料廉价感
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js'

/** 场景里一个节点要渲染的全部信息 */
export interface TopoNode {
  id: string
  role?: string
  /** idle 空闲 / work 执行中 / wait 等人工 / off 离线 */
  state: 'idle' | 'work' | 'wait' | 'off'
  /** 归属主机，同主机的节点聚成一簇 */
  host?: string
  /** 正在处理的任务标题，悬停时展示 */
  workingOn?: string
  /** 挂在该节点身上的任务数 */
  taskCount?: number
  /** 正在运行任务摘要（节点常驻显示），有值即显示「运行」行 */
  running?: string
  /** 待执行任务数（节点常驻显示），>0 显示「待 N」 */
  queued?: number
  /** 排队任务摘要列表，任务牌逐条显示（超过3条折叠为 +N） */
  queuedItems?: string[]
  /**
   * 造型类别。造型只认这个字段，不按 role 文本猜——
   * role 是人维护的、随时会改（把「测试」改成别的就变形），且 role 相同的人本就该长得一样。
   * server = 主服务本体（不是节点）/ pm = 调度层 / agent = 接入节点。
   */
  kind?: 'server' | 'pm' | 'agent'
  /** 展示名：agent 用节点名，server 用真实地址 */
  label?: string
  /** 悬停时补一行更具体的说明 */
  subtitle?: string
}

/** 一条流转边：from 把任务交给 to */
export interface TopoFlow {
  from: string
  to: string
  /** 最近的交接时刻，用于判断是否高亮 */
  at?: number
  /**
   * link = 连接关系（在线节点 ↔ 主服务，常亮，表示"连着"）
   * flow = 任务流转（工单 handoff，带流动光点）
   * 两者语义不同，必须分开画：以前只有 flow，于是"在线但没发生过交接"的节点看起来是断连的。
   */
  kind?: 'link' | 'flow'
}

export interface TopoData {
  nodes: TopoNode[]
  flows: TopoFlow[]
}

/** 状态色沿用控制台原版：绿空闲 橙执行 琥珀等人工 灰离线（work 改橙与任务牌运行条一致） */
const COLORS = {
  idle: 0x3ddc97,
  work: 0xff9a2e,
  wait: 0xffb340,
  off: 0x6b7d95,
  wire: 0x2f86d8,
}

/** 实体主体固定用科技蓝；状态色只走发光，整块染色会像荧光玩具 */
const BODY_COLOR = 0x3d9fe8

const STATE_TXT: Record<string, string> = { idle: '空闲', work: '执行中', wait: '等人工', off: '离线' }
// 主体基色：仅 agent 节点 work 态橙体；server/PM 固定科技蓝，
// 它们的 state 只是展示语义，不代表「在干活」
function bodyColorOf(node: TopoNode): number {
  return node.kind === 'agent' && node.state === 'work' ? 0xff8c1a : BODY_COLOR
}

/** hub-center 以外的节点都归成一个"局域网主机"簇 */
const LOCAL_HOST = 'local'

/** 主机簇的平面坐标：中心留给 hub 与调度层，其余主机围成一圈 */
function hostPositions(hosts: string[]): Map<string, THREE.Vector3> {
  const map = new Map<string, THREE.Vector3>()
  // 中心一列：调度层在上，hub 服务器在下，两者都常驻
  map.set('hub', new THREE.Vector3(0, 0, -6))
  map.set('hub-center', new THREE.Vector3(0, 0, 4))

  // 局域网机器全归一个簇，避免每台机器各占一圈把布局撑散
  const outer = hosts.filter((h) => h !== 'hub-center' && h !== 'hub')
  if (!outer.length) return map
  map.set(LOCAL_HOST, new THREE.Vector3(0, 0, 16))
  return map
}

function solidMetal(color: number, glow = 0.15) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color).multiplyScalar(0.9),
    metalness: 0.95,
    roughness: 0.18,
    emissive: new THREE.Color(color),
    emissiveIntensity: glow,
    envMapIntensity: 1.8,
  })
}

function glassBody(color: number, emissive = 0.18) {
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.35),
    metalness: 0,
    roughness: 0.06,
    transmission: 0.86,
    thickness: 1.4,
    ior: 1.52,
    transparent: true,
    opacity: 0.82,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    emissive: new THREE.Color(color),
    emissiveIntensity: emissive,
    envMapIntensity: 1.6,
    side: THREE.FrontSide,
  })
}

function coreMat(color: number, strength = 1) {
  return new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.4 * strength) })
}

const glowCanvasCache = new Map<string, THREE.CanvasTexture>()
function glowTexture(kind: 'soft' | 'floor') {
  const cached = glowCanvasCache.get(kind)
  if (cached) return cached
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 256
  const ctx = canvas.getContext('2d')!
  const grd = ctx.createRadialGradient(128, 128, 0, 128, 128, 128)
  if (kind === 'soft') {
    grd.addColorStop(0, 'rgba(255,255,255,0.85)')
    grd.addColorStop(0.35, 'rgba(255,255,255,0.28)')
    grd.addColorStop(0.7, 'rgba(255,255,255,0.05)')
  } else {
    grd.addColorStop(0, 'rgba(40,120,255,0.16)')
    grd.addColorStop(0.45, 'rgba(28,80,190,0.05)')
  }
  grd.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = grd
  ctx.fillRect(0, 0, 256, 256)
  const tex = new THREE.CanvasTexture(canvas)
  glowCanvasCache.set(kind, tex)
  return tex
}

/**
 * 节点任务牌：任务列表卡片。每条任务一个圆角 item：
 * 运行中=橙色边框+脉冲点+橙字；排队=灰蓝 item。内容变化才重绘（按内容键缓存）
 */
/** 任务牌产物：纹理 + 高宽比（调用方按比例定尺寸） */
interface BoardTex {
  tex: THREE.CanvasTexture
  aspect: number
}
const boardFullCache = new Map<string, BoardTex>()
function taskBoardTexture(
  name: string,
  running: string | undefined,
  queuedItems: string[] | undefined,
): BoardTex {
  const items = queuedItems ?? []
  const extra = Math.max(0, items.length - 3)
  const shown = items.slice(0, 3)
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)
  const key = name + '|' + (running ?? '') + '|' + items.join('|') + '|' + extra
  const cached = boardFullCache.get(key)
  if (cached) return cached

  const W = 560
  const ROW = 64
  const PAD = 24
  const rows: { text: string; kind: 'name' | 'run' | 'queued' | 'more' }[] = [
    { text: name.length > 20 ? name.slice(0, 20) + '…' : name, kind: 'name' },
  ]
  if (running) rows.push({ text: clip(running, 16), kind: 'run' })
  for (const it of shown) rows.push({ text: clip(it, 16), kind: 'queued' })
  if (extra > 0) rows.push({ text: '… 还有 ' + extra + ' 条', kind: 'more' })

  const H = PAD + rows.length * ROW + PAD - 14
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!

  // 整卡深底：毛玻璃感，弱边框
  ctx.fillStyle = 'rgba(7,13,26,0.82)'
  ctx.strokeStyle = 'rgba(70,110,160,0.45)'
  ctx.lineWidth = 2
  const r = 20
  ctx.beginPath()
  ctx.roundRect(4, 4, W - 8, H - 8, r)
  ctx.fill()
  ctx.stroke()

  const itemR = 14
  let y = PAD
  for (const row of rows) {
    if (row.kind === 'name') {
      ctx.font = '600 28px system-ui, sans-serif'
      ctx.fillStyle = 'rgba(168,192,222,0.95)'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(row.text, 30, y + ROW / 2 - 4)
    } else if (row.kind === 'run') {
      // 运行中 item：橙描边圆角条 + 脉冲点 + 橙字
      const h = ROW - 16
      ctx.fillStyle = 'rgba(60,32,8,0.65)'
      ctx.strokeStyle = 'rgba(255,168,60,0.85)'
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.roundRect(22, y, W - 44, h, itemR)
      ctx.fill()
      ctx.stroke()
      // 脉冲点
      ctx.beginPath()
      ctx.arc(50, y + h / 2, 7, 0, Math.PI * 2)
      ctx.fillStyle = '#ffb040'
      ctx.fill()
      ctx.font = '600 30px system-ui, sans-serif'
      ctx.fillStyle = '#ffc861'
      ctx.textAlign = 'left'
      ctx.fillText(row.text, 68, y + h / 2 + 1)
    } else if (row.kind === 'queued') {
      // 排队 item：灰蓝低调条
      const h = ROW - 18
      ctx.fillStyle = 'rgba(24,38,60,0.7)'
      ctx.strokeStyle = 'rgba(70,110,160,0.35)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.roundRect(22, y, W - 44, h, itemR)
      ctx.fill()
      ctx.stroke()
      ctx.font = '500 27px system-ui, sans-serif'
      ctx.fillStyle = 'rgba(150,180,215,0.92)'
      ctx.textAlign = 'left'
      ctx.fillText(row.text, 52, y + h / 2 + 1)
    } else {
      // 折叠行
      ctx.font = '500 26px system-ui, sans-serif'
      ctx.fillStyle = 'rgba(130,155,185,0.75)'
      ctx.textAlign = 'left'
      ctx.fillText(row.text, 52, y + ROW / 2 - 8)
    }
    y += ROW
  }

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  // 缓存上限防长跑泄漏
  if (boardFullCache.size > 60) {
    const first = boardFullCache.keys().next().value
    if (first !== undefined) boardFullCache.delete(first)
  }
  boardFullCache.set(key, { tex, aspect: H / W })
  return { tex, aspect: H / W }
}

/** 边沿渐变光纹理：底部亮、向上淡出，四边共用一张 */
const edgeGlowCache = new Map<string, THREE.CanvasTexture>()
function edgeGlowTexture(colorCss: string) {
  const cached = edgeGlowCache.get(colorCss)
  if (cached) return cached
  const canvas = document.createElement('canvas')
  canvas.width = 8
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  const grd = ctx.createLinearGradient(0, 0, 0, 128)
  grd.addColorStop(0, 'rgba(0,0,0,0)')
  grd.addColorStop(0.55, colorCss.replace('1)', '0.25)'))
  grd.addColorStop(1, colorCss)
  ctx.fillStyle = grd
  ctx.fillRect(0, 0, 8, 128)
  const tex = new THREE.CanvasTexture(canvas)
  edgeGlowCache.set(colorCss, tex)
  return tex
}

/** 节点脚下的深灰哑光托板；hub 平台四边加渐变上升光效 */
function makePlatform(size = 5.2, edgeGlow = false) {
  const grp = new THREE.Group()
  const H = 0.62
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(size, H, size),
    new THREE.MeshStandardMaterial({ color: 0x232a35, metalness: 0.35, roughness: 0.72 }),
  )
  base.position.y = H / 2
  grp.add(base)

  const top = new THREE.Mesh(
    new THREE.BoxGeometry(size * 0.995, 0.03, size * 0.995),
    new THREE.MeshStandardMaterial({ color: 0x2b3442, metalness: 0.3, roughness: 0.6 }),
  )
  top.position.y = H + 0.005
  grp.add(top)

  const edge = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(size, H, size)),
    new THREE.LineBasicMaterial({ color: 0x5a7a9e, transparent: true, opacity: 0.55 }),
  )
  edge.position.y = H / 2
  grp.add(edge)

  if (edgeGlow) {
    // 四条边的渐变光幕：从底板边缘向上淡出，双面渲染两侧都可见
    const tex = edgeGlowTexture('rgba(70,160,255,1)')
    const gh = 2.6
    const off = size / 2 - 0.06
    const sides: [number, number, number][] = [
      [0, off, 0], [0, -off, Math.PI], [off, 0, -Math.PI / 2], [-off, 0, Math.PI / 2],
    ]
    for (const [x, z, ry] of sides) {
      const glow = new THREE.Mesh(
        new THREE.PlaneGeometry(size - 0.1, gh),
        new THREE.MeshBasicMaterial({
          map: tex,
          transparent: true,
          opacity: 0.5,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      )
      glow.position.set(x, H + gh / 2 - 0.05, z)
      glow.rotation.y = ry
      grp.add(glow)
    }
  }
  return grp
}

/** 数据块造型：玻璃主体 + 腰缝发光 + 顶部独立块 */
function makeCubeCluster(color: number) {
  const g = new THREE.Group()
  g.add(new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.9, 1.9), glassBody(color)))

  const seam = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.07, 1.95), coreMat(color, 1.5))
  g.add(seam)

  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), glassBody(color, 0.22))
  cap.position.set(0.1, 1.56, -0.1)
  g.add(cap)
  const capSeam = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.05, 0.95), coreMat(color, 1.6))
  capSeam.position.copy(cap.position).add(new THREE.Vector3(0, -0.48, 0))
  g.add(capSeam)

  const mods: [number, number, number, number][] = [
    [-1.5, -0.6, 0.5, 0.62],
    [1.45, -0.2, -0.55, 0.5],
    [0.3, -1.3, 0.85, 0.44],
  ]
  for (const [sx, sy, sz, sc] of mods) {
    const mod = new THREE.Mesh(new THREE.BoxGeometry(sc, sc, sc), glassBody(color, 0.16))
    mod.position.set(sx, sy, sz)
    g.add(mod)
  }
  g.userData.cap = cap
  return g
}

/** 核心球造型：玻璃球 + 赤道发光带 + 金属结构环 + 卫星 */
function makeSphereCore(color: number) {
  const g = new THREE.Group()
  g.add(new THREE.Mesh(new THREE.SphereGeometry(1.25, 48, 32), glassBody(color, 0.2)))

  const belt = new THREE.Mesh(new THREE.TorusGeometry(1.26, 0.05, 8, 96), coreMat(color, 1.7))
  belt.rotation.x = Math.PI / 2
  g.add(belt)

  g.userData.rings = []
  for (const tilt of [0.5, -0.5]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.85, 0.05, 10, 96), solidMetal(color, 0.25))
    ring.rotation.x = Math.PI / 2 + tilt
    ring.rotation.z = tilt * 1.3
    g.add(ring)
    g.userData.rings.push(ring)
  }

  g.userData.sats = []
  for (let i = 0; i < 3; i++) {
    const sat = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), solidMetal(color, 0.35))
    g.add(sat)
    g.userData.sats.push(sat)
  }
  return g
}

/** 服务器塔造型：三层玻璃叠块 + 层缝发光 + 面板灯 */
function makeServerStack(color: number) {
  const g = new THREE.Group()
  for (let i = 0; i < 3; i++) {
    const y = -0.95 + i * 0.95
    const slab = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.62, 1.5), glassBody(color, 0.2))
    slab.position.y = y
    g.add(slab)
    if (i < 2) {
      const gap = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.04, 1.35), coreMat(color, 1.5))
      gap.position.y = y + 0.48
      g.add(gap)
    }
    for (let j = 0; j < 3; j++) {
      const led = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.04), coreMat(0xbff2ff, 1))
      led.position.set(-0.66 + j * 0.24, y, 0.77)
      g.add(led)
    }
  }
  const cap = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.2, 0.85), coreMat(0xbff2ff, 1))
  cap.position.y = 1.62
  g.add(cap)
  g.userData.cap = cap
  return g
}

function shapeFor(node: TopoNode) {
  // 造型只认 kind，不按 role 文本猜。
  // 以前 role 命中 /测试|QA/ 会被画成六棱柱，于是同一个人的 role 一改（比如被改成「测试」）
  // 它在图里就跟别人长得不一样——role 是给人看的标签，不该影响几何体。
  if (node.kind === 'server') return makeServerStack
  if (node.kind === 'pm') return makeSphereCore
  return makeCubeCluster
}


/** 把状态色刷到发光件上：只改自发光，保留主体固定蓝 */
function applyAccent(root: THREE.Object3D, accent: number) {
  const c = new THREE.Color(accent)
  root.traverse((o) => {
    const mat = (o as THREE.Mesh).material as THREE.Material | undefined
    if (!mat) return
    if (mat instanceof THREE.MeshBasicMaterial) {
      mat.color.copy(c).multiplyScalar(1.4)
      return
    }
    const m = mat as THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial
    if (m.emissive) {
      m.emissive.copy(c)
      m.emissiveIntensity = Math.max(m.emissiveIntensity, 0.22)
    }
  })
}

/** 把折线展开成贴地扁平光带 */
function makeRibbon(pts: THREE.Vector3[], width: number, color: number, opacity: number) {
  const positions: number[] = []
  const indices: number[] = []
  const half = width / 2
  let vi = 0
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i]
    const q = pts[i + 1]
    if (!p || !q) continue
    const dx = q.x - p.x
    const dz = q.z - p.z
    const len = Math.hypot(dx, dz)
    if (len < 1e-4) continue
    const nx = (-dz / len) * half
    const nz = (dx / len) * half
    const ax = p.x - (dx / len) * 0.01
    const az = p.z - (dz / len) * 0.01
    const bx = q.x + (dx / len) * 0.01
    const bz = q.z + (dz / len) * 0.01
    positions.push(ax + nx, 0, az + nz, ax - nx, 0, az - nz, bx + nx, 0, bz + nz, bx - nx, 0, bz - nz)
    indices.push(vi, vi + 1, vi + 2, vi + 2, vi + 1, vi + 3)
    vi += 4
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setIndex(indices)
  geo.computeVertexNormals()
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  )
  mesh.position.y = 0.05
  return mesh
}

export interface TopoSceneOptions {
  /** 悬停节点时的回调，用于外部渲染 tooltip */
  onHover?: (node: TopoNode | null, screen: { x: number; y: number } | null) => void
}

export class TopoScene {
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private controls: OrbitControls
  private composer: EffectComposer
  private clock = new THREE.Clock()
  private raf = 0
  private resizeObserver?: ResizeObserver

  private nodeLayer = new THREE.Group()
  private wireLayer = new THREE.Group()
  private decorLayer = new THREE.Group()
  private nodes = new Map<string, { data: TopoNode; grp: THREE.Group; body: THREE.Group; hit: THREE.Mesh; basePos: THREE.Vector3 }>()
  private flows: { path: THREE.CurvePath<THREE.Vector3>; dots: { sprite: THREE.Sprite; t: number }[]; speed: number }[] = []
  private shards: THREE.Mesh[] = []
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2(-10, -10)
  private hoveredId: string | null = null
  private disposed = false
  private host: HTMLElement
  private opts: TopoSceneOptions
  private lastData: TopoData = { nodes: [], flows: [] }

  constructor(container: HTMLElement, opts: TopoSceneOptions = {}) {
    this.host = container
    this.opts = opts

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(container.clientWidth || 1, container.clientHeight || 1)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 0.92
    this.renderer.domElement.style.display = 'block'
    this.renderer.domElement.style.cursor = 'grab'
    container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x050914)
    this.scene.fog = new THREE.FogExp2(0x03060f, 0.012)

    this.camera = new THREE.PerspectiveCamera(42, (container.clientWidth || 1) / (container.clientHeight || 1), 0.1, 400)
    const PITCH = THREE.MathUtils.degToRad(52)
    const YAW = THREE.MathUtils.degToRad(-35)
    const DIST = 62
    this.camera.position.set(
      Math.sin(YAW) * Math.cos(PITCH) * DIST * -1,
      Math.sin(PITCH) * DIST,
      Math.cos(YAW) * Math.cos(PITCH) * DIST,
    )
    this.camera.lookAt(0, 2, 0)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(0, 1.5, 0)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.06
    this.controls.minDistance = 20
    this.controls.maxDistance = 120
    this.controls.maxPolarAngle = THREE.MathUtils.degToRad(78)
    this.controls.minPolarAngle = THREE.MathUtils.degToRad(18)
    this.controls.update()

    this.setupEnvironment()
    this.setupLights()
    this.setupGround()

    this.scene.add(this.nodeLayer, this.wireLayer, this.decorLayer)
    this.buildDecor()

    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(container.clientWidth || 1, container.clientHeight || 1), 0.5, 0.4, 0.72))
    this.composer.addPass(new OutputPass())

    this.bindEvents()
    this.animate()
  }

  private setupEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    pmrem.compileEquirectangularShader()
    new EXRLoader().load(
      '/cc0/night.bin.exr',
      (tex) => {
        if (this.disposed) return
        tex.mapping = THREE.EquirectangularReflectionMapping
        this.scene.environment = pmrem.fromEquirectangular(tex).texture
        this.scene.environmentIntensity = 1.15
        tex.dispose()
        pmrem.dispose()
      },
      undefined,
      () => {
        // 环境缺失时用纯色兜底，避免玻璃显成塑料
        this.scene.environment = null
        pmrem.dispose()
      },
    )
  }

  private setupLights() {
    this.scene.add(new THREE.AmbientLight(0x3f6ea8, 1.6))
    const key = new THREE.DirectionalLight(0xd8ecff, 2.4)
    key.position.set(-16, 30, 14)
    this.scene.add(key)
    const rim = new THREE.DirectionalLight(0x4f9bff, 2)
    rim.position.set(20, 10, -18)
    this.scene.add(rim)
    const top = new THREE.DirectionalLight(0xbfe6ff, 1.4)
    top.position.set(6, 30, -8)
    this.scene.add(top)
  }

  private setupGround() {
    const grid = new THREE.GridHelper(120, 60, 0x1b4a80, 0x102a4a)
    const mat = grid.material as THREE.LineBasicMaterial
    mat.transparent = true
    mat.opacity = 0.55
    grid.position.y = -0.02
    this.scene.add(grid)

    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshBasicMaterial({
        map: glowTexture('floor'),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    )
    glow.rotation.x = -Math.PI / 2
    this.scene.add(glow)
  }

  private buildDecor() {
    // 悬浮碎片：缓慢漂移。背景塔楼已移除：高圆柱会遮挡环形排布后的节点/任务牌
    const shardMat = new THREE.MeshStandardMaterial({
      color: 0x123a5e,
      emissive: new THREE.Color(0x4fb8ff),
      emissiveIntensity: 1.6,
      metalness: 0.7,
      roughness: 0.3,
    })
    for (let i = 0; i < 18; i++) {
      const s = new THREE.Mesh(new THREE.IcosahedronGeometry(0.18 + Math.random() * 0.22, 0), shardMat)
      const a = Math.random() * Math.PI * 2
      const rad = 11 + Math.random() * 8
      s.position.set(Math.cos(a) * rad, 1.2 + Math.random() * 6, Math.sin(a) * rad)
      s.userData.spin = (Math.random() - 0.5) * 1.2
      s.userData.bob = Math.random() * Math.PI * 2
      s.userData.baseY = s.position.y
      this.decorLayer.add(s)
      this.shards.push(s)
    }
  }

  private bindEvents() {
    const el = this.renderer.domElement
    el.addEventListener('pointermove', this.onPointerMove)
    el.addEventListener('pointerleave', this.onPointerLeave)

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize())
      this.resizeObserver.observe(this.host)
    }
  }

  private onPointerMove = (e: PointerEvent) => {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    this.lastPointer = { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  private lastPointer = { x: 0, y: 0 }

  private onPointerLeave = () => {
    this.pointer.set(-10, -10)
    if (this.hoveredId) {
      this.hoveredId = null
      this.opts.onHover?.(null, null)
    }
  }

  /** 灌入数据：重建节点与光缆 */
  setData(data: TopoData) {
    if (this.disposed) return
    this.lastData = data
    this.rebuild(data)
  }

  private disposeLayer(layer: THREE.Group) {
    for (const child of [...layer.children]) {
      layer.remove(child)
      child.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (mesh.geometry) mesh.geometry.dispose()
        const m = mesh.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(m)) m.forEach((x) => x.dispose())
        else m?.dispose()
      })
    }
  }

  private rebuild(data: TopoData) {
    this.disposeLayer(this.nodeLayer)
    this.disposeLayer(this.wireLayer)
    this.nodes.clear()
    this.flows = []

    // 主机分簇：hub/调度居中，其余节点合成局域网弧
    const hosts = [...new Set(data.nodes.map((n) => n.host || 'default'))]
    const hostPos = hostPositions(hosts)
    const byHost = new Map<string, TopoNode[]>()
    for (const n of data.nodes) {
      const raw = n.host || 'default'
      const h = raw === 'hub-center' || raw === 'hub' ? raw : LOCAL_HOST
      if (!byHost.has(h)) byHost.set(h, [])
      byHost.get(h)!.push(n)
    }

    const placed: { node: TopoNode; pos: THREE.Vector3 }[] = []
    for (const [host, list] of byHost) {
      const center = hostPos.get(host) ?? new THREE.Vector3()
      if (host === LOCAL_HOST) {
        // 环绕中心：节点每 3 个并排成一小簇，簇沿环分布——
        // 单纯一人一圈太散，并排紧凑且仍保持环绕主服务的整体形态
        const online = list.filter((n) => n.state !== 'off')
        const offline = list.filter((n) => n.state === 'off')
        const clusters: TopoNode[][] = []
        for (let i = 0; i < online.length; i += 3) clusters.push(online.slice(i, i + 3))
        // 离线节点单独归一簇，摆在环上空档
        if (offline.length) clusters.push(offline)
        const RAD = Math.max(16, 4 + clusters.length * 7)
        const GAP = 8
        clusters.forEach((cluster, ci) => {
          const ang = (ci / Math.max(1, clusters.length)) * Math.PI * 2 - Math.PI / 2
          const cx = Math.cos(ang) * RAD
          const cz = Math.sin(ang) * RAD * 0.78
          const sx = -((cluster.length - 1) * GAP) / 2
          // 簇内并排：沿环切线方向排开，视觉上贴着环
          const tx = -Math.sin(ang)
          const tz = Math.cos(ang) * 0.78
          cluster.forEach((n, i) => {
            placed.push({ node: n, pos: new THREE.Vector3(cx + tx * (sx + i * GAP), 0, cz + tz * (sx + i * GAP)) })
          })
        })
        continue
      }
      list.forEach((n, i) => {
        const ang = (i / Math.max(1, list.length)) * Math.PI * 2
        const rad = list.length > 1 ? 3.6 : 0
        placed.push({ node: n, pos: center.clone().add(new THREE.Vector3(Math.cos(ang) * rad, 0, Math.sin(ang) * rad)) })
      })
    }

    for (const { node, pos } of placed) {
      // accent 只对 agent 随状态变色；server/PM 固定科技蓝（它们的 state 只是展示语义）
      const accent = node.kind === 'agent' || !node.kind
        ? (COLORS[node.state] ?? COLORS.idle)
        : BODY_COLOR
      const grp = new THREE.Group()
      grp.position.copy(pos)
      // hub/主服务平台带四边渐变光幕；普通节点平台保持哑光
      grp.add(makePlatform(5.2, node.kind !== 'agent'))

      // 主体固定蓝，accent 只决定缝隙与点光的颜色
      const body = shapeFor(node)(bodyColorOf(node))
      body.position.y = 2.35
      applyAccent(body, accent)
      grp.add(body)

      // 实体内部光源：照亮自身玻璃并溢出到平台
      if (node.state !== 'off') {
        const inner = new THREE.PointLight(accent, 12, 9, 2)
        inner.position.y = 2.35
        grp.add(inner)
      }

      // 悬浮光柱，制造「浮起来」的观感（高 1.6 挂在 y1.15，够不到牌）
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.04, 0.16, 1.6, 10, 1, true),
        new THREE.MeshBasicMaterial({
          color: accent,
          transparent: true,
          opacity: 0.28,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        }),
      )
      beam.position.y = 1.15
      grp.add(beam)

      // 任务牌：仅「有活」时出现——运行中或排队>0，空闲节点不挂牌。
      const boardItems = node.queuedItems ?? []
      const hasBoard = node.kind === 'agent' && (node.running || boardItems.length > 0)
      if (hasBoard) {
        const { tex, aspect } = taskBoardTexture(node.label ?? node.id, node.running, boardItems)
        const bw = 7.5
        const board = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: tex,
            transparent: true,
            depthWrite: false,
          }),
        )
        // 高度按内容行数自适应（纹理宽高比）
        board.scale.set(bw, bw * aspect, 1)
        board.position.y = 6.2 + (bw * aspect) / 2
        grp.add(board)
      }

      this.nodeLayer.add(grp)

      const hit = new THREE.Mesh(new THREE.BoxGeometry(5.6, 7, 5.6), new THREE.MeshBasicMaterial({ visible: false }))
      hit.position.y = 3
      hit.userData.nodeId = node.id
      grp.add(hit)

      this.nodes.set(node.id, { data: node, grp, body, hit, basePos: pos.clone() })
    }

    // 光缆：只连存在的两端。link 先画（常亮连接），flow 后画（任务流转动画）
    const ordered = [...data.flows].sort(
      (a, b) => (a.kind === 'link' ? 0 : 1) - (b.kind === 'link' ? 0 : 1),
    )
    ordered.forEach((f, idx) => {
      const a = this.nodes.get(f.from)
      const b = this.nodes.get(f.to)
      if (!a || !b || f.from === f.to) return
      this.buildWire(a.basePos, b.basePos, idx, f.kind ?? 'flow')
    })

    // 视角自适应：节点多时拉远
    const spread = Math.max(1, ...placed.map((p) => p.pos.length()))
    this.controls.maxDistance = Math.max(80, spread * 4)
    this.controls.update()
  }

  private buildWire(a: THREE.Vector3, b: THREE.Vector3, seed: number, kind: 'link' | 'flow' = 'flow') {
    const isLink = kind === 'link'
    const PAD = 3.0
    const portOf = (p: THREE.Vector3, toward: THREE.Vector3) => {
      const d = toward.clone().sub(p)
      const horizontal = Math.abs(d.x) > Math.abs(d.z)
      return horizontal
        ? p.clone().add(new THREE.Vector3(Math.sign(d.x) * PAD, 0, 0))
        : p.clone().add(new THREE.Vector3(0, 0, Math.sign(d.z) * PAD))
    }
    const s = portOf(a, b)
    const e = portOf(b, a)
    const pts: THREE.Vector3[] = [a.clone().setY(0), s]
    const dx = e.x - s.x
    const dz = e.z - s.z
    if (Math.abs(dx) > Math.abs(dz)) {
      pts.push(new THREE.Vector3(s.x + dx, 0, s.z))
      pts.push(new THREE.Vector3(s.x + dx, 0, e.z))
    } else {
      pts.push(new THREE.Vector3(s.x, 0, s.z + dz))
      pts.push(new THREE.Vector3(e.x, 0, s.z + dz))
    }
    pts.push(e, b.clone().setY(0))
    const clean = pts.filter((p, i) => {
      if (i === 0) return true
      const prev = pts[i - 1]
      return !prev || p.distanceTo(prev) > 0.05
    })

    // link（连接）用青绿系、更宽更稳；flow（流转）用蓝色系 + 流动光点
    this.wireLayer.add(makeRibbon(clean, isLink ? 1.9 : 1.6, isLink ? 0x0f7a63 : 0x1466c4, isLink ? 0.22 : 0.2))
    this.wireLayer.add(makeRibbon(clean, isLink ? 1.0 : 0.8, isLink ? 0x2fd6a6 : 0x2b8fe0, isLink ? 0.42 : 0.5))
    this.wireLayer.add(makeRibbon(clean, isLink ? 0.3 : 0.26, isLink ? 0x9dffe0 : 0x74d0ff, isLink ? 0.75 : 0.85))

    const path = new THREE.CurvePath<THREE.Vector3>()
    for (let i = 1; i < clean.length; i++) path.add(new THREE.LineCurve3(clean[i - 1], clean[i]))

    const dots: { sprite: THREE.Sprite; t: number }[] = []
    // 连接线不跑光点：它表达"通着"，不是"正在送东西"；跑点会跟流转线混淆
    const dotCount = isLink ? 0 : 3
    for (let i = 0; i < dotCount; i++) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          color: 0x9fe0ff,
          transparent: true,
          opacity: 0.85,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      )
      sprite.scale.setScalar(0.6)
      this.wireLayer.add(sprite)
      dots.push({ sprite, t: i / dotCount })
    }
    this.flows.push({ path, dots, speed: 0.16 + ((seed * 37) % 10) * 0.01 })
  }

  private resize() {
    if (this.disposed) return
    const w = this.host.clientWidth || 1
    const h = this.host.clientHeight || 1
    this.renderer.setSize(w, h)
    this.composer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  private animate = () => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.animate)
    const t = this.clock.getElapsedTime()
    const dt = Math.min(this.clock.getDelta(), 0.05)

    for (const [, n] of this.nodes) {
      const off = n.data.state === 'off' ? 0 : Math.sin(t * 1.1 + n.basePos.x * 0.3) * 0.06
      n.body.position.y = 2.35 + off
      n.body.rotation.y += dt * (n.data.state === 'off' ? 0.08 : 0.35)
      const rings = n.body.userData.rings as THREE.Mesh[] | undefined
      if (rings) rings.forEach((r, i) => { r.rotation.z += dt * (i ? -0.5 : 0.7) })
      const cap = n.body.userData.cap as THREE.Mesh | undefined
      if (cap) cap.rotation.y -= dt * 0.9
      const sats = n.body.userData.sats as THREE.Mesh[] | undefined
      if (sats) {
        sats.forEach((s, i) => {
          const a = t * 0.55 + (i / sats.length) * Math.PI * 2
          s.position.set(Math.cos(a) * 2.15, Math.sin(a * 1.7 + i) * 0.6, Math.sin(a) * 2.15)
        })
      }
    }

    for (const f of this.flows) {
      for (const d of f.dots) {
        d.t = (d.t + dt * f.speed) % 1
        const pt = f.path.getPointAt(d.t)
        if (pt) d.sprite.position.copy(pt)
        d.sprite.material.opacity = 0.25 + Math.sin(d.t * Math.PI) * 0.75
      }
    }

    for (const s of this.shards) {
      s.rotation.y += dt * s.userData.spin * 0.4
      s.rotation.x += dt * s.userData.spin * 0.2
      s.position.y = s.userData.baseY + Math.sin(t * 0.6 + s.userData.bob) * 0.35
    }

    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hitList = [...this.nodes.values()].map((n) => n.hit)
    const hits = this.raycaster.intersectObjects(hitList, false)
    const id = (hits[0]?.object.userData.nodeId as string | undefined) ?? null
    if (id !== this.hoveredId) {
      this.hoveredId = id
      const n = id ? this.nodes.get(id) : null
      this.opts.onHover?.(n ? n.data : null, n ? { ...this.lastPointer } : null)
    } else if (id && this.hoveredId) {
      // 悬停中移动时同步 tooltip 位置
      this.opts.onHover?.(this.nodes.get(id)!.data, { ...this.lastPointer })
    }

    this.controls.update()
    this.composer.render()
  }

  /** 当前数据（供组件侧读取） */
  data() {
    return this.lastData
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.resizeObserver?.disconnect()
    const el = this.renderer.domElement
    el.removeEventListener('pointermove', this.onPointerMove)
    el.removeEventListener('pointerleave', this.onPointerLeave)
    this.disposeLayer(this.nodeLayer)
    this.disposeLayer(this.wireLayer)
    this.disposeLayer(this.decorLayer)
    this.controls.dispose()
    this.composer.dispose()
    this.renderer.dispose()
    el.remove()
  }
}

export { STATE_TXT }