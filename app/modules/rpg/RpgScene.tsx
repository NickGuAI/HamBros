import { type MutableRefObject, type RefObject, forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Application, extend, useTick } from '@pixi/react'
import { Assets, Container, Rectangle, Sprite, Text, Texture, type Application as PixiApplication } from 'pixi.js'
import type { WorldAgent } from './use-world-state'
import { AgentSprite } from './AgentSprite'
import { getTileFrame } from './avatar-hash'
import { drawParticleBurst, getParticleStyleForTool } from './particles'
import { TileMapLayer } from './TileMapLayer'
import { PlayerSprite } from './PlayerSprite'
import { ROOM_WIDTH, ROOM_HEIGHT, TABLE_SPOTS, ANVIL_SPOTS, IDLE_SPOTS, TILE_SIZE } from './room-layout'

extend({ Container, Sprite, Text })

// tiny-creatures tile indices: 127 = regular agent, 128 = factory agent
const TILE_REGULAR = 127
const TILE_FACTORY = 128

// Player spawn matches PlayerSprite internals
const PLAYER_SPAWN = { x: ROOM_WIDTH / 2, y: ROOM_HEIGHT - 28 }
const INTERACT_RANGE = 20

function isFactoryAgent(agent: WorldAgent): boolean {
  return agent.agentType === 'codex'
}

function buildPositionMap(agents: WorldAgent[]): Map<string, { x: number; y: number }> {
  const map = new Map<string, { x: number; y: number }>()

  const activeRegular = agents
    .filter((a) => a.status === 'active' && !isFactoryAgent(a))
    .sort((a, b) => a.id.localeCompare(b.id))
  const activeFactory = agents
    .filter((a) => a.status === 'active' && isFactoryAgent(a))
    .sort((a, b) => a.id.localeCompare(b.id))
  const resting = agents
    .filter((a) => a.status !== 'active')
    .sort((a, b) => a.id.localeCompare(b.id))

  activeRegular.forEach((a, i) => {
    map.set(a.id, TABLE_SPOTS[i] ?? TABLE_SPOTS[TABLE_SPOTS.length - 1])
  })
  activeFactory.forEach((a, i) => {
    map.set(a.id, ANVIL_SPOTS[i] ?? ANVIL_SPOTS[ANVIL_SPOTS.length - 1])
  })
  resting.forEach((a, i) => {
    map.set(a.id, IDLE_SPOTS[i % IDLE_SPOTS.length])
  })

  return map
}

interface RuntimeAgent {
  id: string
  tileIndex: number
  zone: 'DESK' | 'IDLE'
  x: number
  y: number
  targetX: number
  targetY: number
  status: WorldAgent['status']
  phase: WorldAgent['phase']
  phaseChangedAt?: number
  completedAt?: number
  markedForRemoval: boolean
}

interface LoadedTextures {
  tiles: Texture
  creatures: Texture
}

// ---------------------------------------------------------------------------
// FPS probe
// ---------------------------------------------------------------------------

function FpsProbe({ onSample }: { onSample: (fps: number) => void }) {
  const stateRef = useRef({ frames: 0, elapsedMs: 0 })

  useTick((ticker) => {
    stateRef.current.frames += 1
    stateRef.current.elapsedMs += ticker.deltaMS

    if (stateRef.current.elapsedMs >= 500) {
      const fps = (stateRef.current.frames * 1000) / stateRef.current.elapsedMs
      onSample(fps)
      stateRef.current.frames = 0
      stateRef.current.elapsedMs = 0
    }
  })

  return null
}

// ---------------------------------------------------------------------------
// Camera controller — runs in Pixi ticker, smoothly follows the player
// ---------------------------------------------------------------------------

function CameraController({
  cameraRef,
  playerPosRef,
  viewport,
  scale,
}: {
  cameraRef: RefObject<Container | null>
  playerPosRef: MutableRefObject<{ x: number; y: number }>
  viewport: { width: number; height: number }
  scale: number
}) {
  useTick(() => {
    const cam = cameraRef.current
    if (!cam) return

    const worldW = ROOM_WIDTH * scale
    const worldH = ROOM_HEIGHT * scale

    // Center map if it fits; follow player (clamped) if it overflows
    const targetX = worldW <= viewport.width
      ? (viewport.width - worldW) / 2
      : Math.max(viewport.width - worldW, Math.min(0, viewport.width / 2 - playerPosRef.current.x * scale))

    const targetY = worldH <= viewport.height
      ? (viewport.height - worldH) / 2
      : Math.max(viewport.height - worldH, Math.min(0, viewport.height / 2 - playerPosRef.current.y * scale))

    cam.x += (Math.round(targetX) - cam.x) * 0.12
    cam.y += (Math.round(targetY) - cam.y) * 0.12
  })

  return null
}

function NearestStreamAgentProbe({
  playerPosRef,
  runtimeAgentsRef,
  streamAgentIds,
  onNearestChange,
}: {
  playerPosRef: MutableRefObject<{ x: number; y: number }>
  runtimeAgentsRef: MutableRefObject<Record<string, RuntimeAgent>>
  streamAgentIds?: Set<string>
  onNearestChange: (nearestId: string | null) => void
}) {
  useTick(() => {
    let nearestId: string | null = null
    let nearestDistanceSquared = INTERACT_RANGE * INTERACT_RANGE
    const player = playerPosRef.current

    for (const runtimeAgent of Object.values(runtimeAgentsRef.current)) {
      if (runtimeAgent.markedForRemoval || !streamAgentIds?.has(runtimeAgent.id)) {
        continue
      }
      const dx = runtimeAgent.targetX - player.x
      const dy = runtimeAgent.targetY - player.y
      const distanceSquared = dx * dx + dy * dy
      if (distanceSquared <= nearestDistanceSquared) {
        nearestDistanceSquared = distanceSquared
        nearestId = runtimeAgent.id
      }
    }

    onNearestChange(nearestId)
  })

  return null
}

// ---------------------------------------------------------------------------
// RpgScene
// ---------------------------------------------------------------------------

export interface RpgSceneHandle {
  emitToolFx: (agentId: string, toolName: string) => void
}

interface RpgSceneProps {
  agents: WorldAgent[]
  className?: string
  streamAgentIds?: Set<string>
  onNearestStreamAgentChange?: (id: string | null) => void
  onInteract?: () => void
  playerFrozen?: boolean
}

export const RpgScene = forwardRef<RpgSceneHandle, RpgSceneProps>(function RpgScene({
  agents,
  className,
  streamAgentIds,
  onNearestStreamAgentChange,
  onInteract,
  playerFrozen = false,
}, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const cameraRef = useRef<Container | null>(null)
  const fxLayerRef = useRef<Container | null>(null)
  const playerPosRef = useRef<{ x: number; y: number }>(PLAYER_SPAWN)
  const nearestStreamAgentRef = useRef<string | null>(null)

  const textureCacheRef = useRef<Map<number, Texture>>(new Map())
  const runtimeAgentsRef = useRef<Record<string, RuntimeAgent>>({})
  const fxCleanupRef = useRef<Array<() => void>>([])

  const [viewport, setViewport] = useState({ width: 1, height: 1 })
  const [textures, setTextures] = useState<LoadedTextures | null>(null)
  const [runtimeAgents, setRuntimeAgents] = useState<Record<string, RuntimeAgent>>({})
  const [nearestStreamAgentId, setNearestStreamAgentId] = useState<string | null>(null)
  const [fps, setFps] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const handleAppInit = useCallback((app: PixiApplication) => {
    app.ticker.maxFPS = 60
  }, [])

  useEffect(() => {
    runtimeAgentsRef.current = runtimeAgents
  }, [runtimeAgents])

  useEffect(() => {
    if (streamAgentIds?.has(nearestStreamAgentRef.current ?? '')) {
      return
    }
    if (nearestStreamAgentRef.current === null) {
      return
    }
    nearestStreamAgentRef.current = null
    setNearestStreamAgentId(null)
    onNearestStreamAgentChange?.(null)
  }, [onNearestStreamAgentChange, streamAgentIds])

  useEffect(() => {
    return () => {
      if (nearestStreamAgentRef.current !== null) {
        onNearestStreamAgentChange?.(null)
      }
      for (const cleanup of fxCleanupRef.current) {
        cleanup()
      }
      fxCleanupRef.current = []
    }
  }, [onNearestStreamAgentChange])

  useEffect(() => {
    let active = true

    void Promise.all([
      Assets.load('/assets/rpg/workroom-tiles.png') as Promise<Texture>,
      Assets.load('/assets/rpg/creatures.png') as Promise<Texture>,
    ]).then(([tiles, creatures]) => {
      if (!active) return
      setTextures({ tiles, creatures })
    }).catch((caught) => {
      const message = caught instanceof Error ? caught.message : 'Failed to load RPG textures'
      if (active) setError(message)
    })

    return () => { active = false }
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const update = () => {
      const rect = host.getBoundingClientRect()
      setViewport({
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
      })
    }

    update()
    const observer = new ResizeObserver(update)
    observer.observe(host)
    return () => { observer.disconnect() }
  }, [])

  useEffect(() => {
    const now = performance.now()
    const posMap = buildPositionMap(agents)

    setRuntimeAgents((previous) => {
      const next: Record<string, RuntimeAgent> = { ...previous }
      const activeIds = new Set(agents.map((agent) => agent.id))

      for (const existing of Object.values(next)) {
        if (!activeIds.has(existing.id)) {
          next[existing.id] = { ...existing, markedForRemoval: true }
        }
      }

      for (const agent of agents) {
        const pos = posMap.get(agent.id)!
        const zone: 'DESK' | 'IDLE' = agent.status === 'active' ? 'DESK' : 'IDLE'
        const existing = next[agent.id]
        const tileIndex = isFactoryAgent(agent) ? TILE_FACTORY : TILE_REGULAR

        if (!existing) {
          next[agent.id] = {
            id: agent.id,
            tileIndex,
            zone,
            x: pos.x,
            y: pos.y,
            targetX: pos.x,
            targetY: pos.y,
            status: agent.status,
            phase: agent.phase,
            phaseChangedAt: now,
            completedAt: agent.status === 'completed' ? now : undefined,
            markedForRemoval: false,
          }
          continue
        }

        const phaseChanged = existing.phase !== agent.phase || existing.status !== agent.status
        next[agent.id] = {
          ...existing,
          tileIndex,
          zone,
          targetX: pos.x,
          targetY: pos.y,
          status: agent.status,
          phase: agent.phase,
          phaseChangedAt: phaseChanged ? now : existing.phaseChangedAt,
          completedAt: existing.completedAt ?? (agent.status === 'completed' ? now : undefined),
          markedForRemoval: false,
        }
      }

      return next
    })
  }, [agents])

  const handleNearestChange = useCallback((nearestId: string | null) => {
    if (nearestStreamAgentRef.current === nearestId) {
      return
    }
    nearestStreamAgentRef.current = nearestId
    setNearestStreamAgentId(nearestId)
    onNearestStreamAgentChange?.(nearestId)
  }, [onNearestStreamAgentChange])

  // Integer scale — largest pixel-perfect zoom where the full map fits in the viewport
  const worldScale = useMemo(
    () => Math.max(1, Math.floor(Math.min(viewport.width / ROOM_WIDTH, viewport.height / ROOM_HEIGHT))),
    [viewport.width, viewport.height],
  )

  // Map bounding rect in screen space — used to draw the border overlay
  const mapBounds = useMemo(() => {
    const w = ROOM_WIDTH * worldScale
    const h = ROOM_HEIGHT * worldScale
    return {
      left: Math.max(0, Math.round((viewport.width - w) / 2)),
      top:  Math.max(0, Math.round((viewport.height - h) / 2)),
      width:  Math.min(viewport.width,  w),
      height: Math.min(viewport.height, h),
    }
  }, [viewport, worldScale])

  const resolveTileTexture = useCallback((tileIndex: number): Texture => {
    if (!textures) return Texture.EMPTY

    const cached = textureCacheRef.current.get(tileIndex)
    if (cached) return cached

    const frame = getTileFrame(tileIndex)
    const texture = new Texture({
      source: textures.creatures.source,
      frame: new Rectangle(frame.x, frame.y, frame.width, frame.height),
    })

    textureCacheRef.current.set(tileIndex, texture)
    return texture
  }, [textures])

  const handleFadeOutComplete = useCallback((id: string) => {
    setRuntimeAgents((previous) => {
      if (!previous[id]) return previous
      const next = { ...previous }
      delete next[id]
      return next
    })
  }, [])

  useImperativeHandle(ref, () => ({
    emitToolFx(agentId: string, toolName: string) {
      const style = getParticleStyleForTool(toolName)
      const layer = fxLayerRef.current
      if (!style || !layer) return

      const target = runtimeAgentsRef.current[agentId]
      const point = target
        ? { x: target.targetX, y: target.targetY }
        : { x: ROOM_WIDTH / 2, y: ROOM_HEIGHT / 2 }

      const cleanup = drawParticleBurst(layer, {
        x: point.x,
        y: point.y,
        color: style.color,
        shape: style.shape,
      })
      fxCleanupRef.current.push(cleanup)
    },
  }), [])

  return (
    <div className={className ?? 'absolute inset-0'} ref={hostRef}>
      {textures ? (
        <Application resizeTo={hostRef} antialias={false} backgroundAlpha={0} onInit={handleAppInit}>
          <FpsProbe onSample={setFps} />
          <CameraController
            cameraRef={cameraRef}
            playerPosRef={playerPosRef}
            viewport={viewport}
            scale={worldScale}
          />
          <NearestStreamAgentProbe
            playerPosRef={playerPosRef}
            runtimeAgentsRef={runtimeAgentsRef}
            streamAgentIds={streamAgentIds}
            onNearestChange={handleNearestChange}
          />
          {/* cameraRef container: x/y managed by CameraController each tick */}
          <pixiContainer ref={cameraRef} scale={{ x: worldScale, y: worldScale } as any}>
            <TileMapLayer tilesTexture={textures.tiles} />
            <pixiContainer>
              {Object.values(runtimeAgents).map((agent) => (
                <AgentSprite
                  key={agent.id}
                  id={agent.id}
                  tileTexture={resolveTileTexture(agent.tileIndex)}
                  x={agent.x}
                  y={agent.y}
                  targetX={agent.targetX}
                  targetY={agent.targetY}
                  status={agent.status}
                  phaseChangedAt={agent.phaseChangedAt}
                  completedAt={agent.completedAt}
                  markedForRemoval={agent.markedForRemoval}
                  onFadeOutComplete={handleFadeOutComplete}
                />
              ))}
            </pixiContainer>
            {nearestStreamAgentId && runtimeAgents[nearestStreamAgentId] ? (
              <pixiText
                text="PRESS SPACE"
                x={runtimeAgents[nearestStreamAgentId].targetX}
                y={runtimeAgents[nearestStreamAgentId].targetY - TILE_SIZE * 1.25}
                anchor={0.5}
                roundPixels
                style={{
                  fontFamily: 'monospace',
                  fontSize: 11,
                  fill: '#fef08a',
                  fontWeight: '700',
                  stroke: '#000000',
                  strokeThickness: 3,
                  align: 'center',
                  letterSpacing: 1,
                }}
              />
            ) : null}
            <PlayerSprite
              creaturesTexture={textures.creatures}
              sharedPosRef={playerPosRef}
              onInteract={onInteract}
              frozen={playerFrozen}
            />
            <pixiContainer ref={fxLayerRef} />
          </pixiContainer>
        </Application>
      ) : null}

      {/* Map border box */}
      <div
        className="pointer-events-none absolute box-content border-2 border-white/25"
        style={mapBounds}
      />

      {error ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/35 px-4 text-center text-xs font-mono text-white/90">
          {error}
        </div>
      ) : null}

      <div className="pointer-events-none absolute right-3 top-3 rounded-md border border-white/20 bg-black/45 px-2 py-1 text-[10px] font-mono uppercase tracking-[0.08em] text-white/90">
        fps {Math.round(fps)}
      </div>
    </div>
  )
})
