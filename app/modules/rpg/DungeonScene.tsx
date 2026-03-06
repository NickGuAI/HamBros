import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Application, extend, useTick } from '@pixi/react'
import { Assets, Container, Rectangle, Sprite, Texture } from 'pixi.js'
import type { WorldAgent } from '@/types'
import { AgentSprite } from './AgentSprite'
import { DungeonBackground, DUNGEON_HEIGHT, DUNGEON_WIDTH } from './DungeonBackground'
import { getAvatarTileIndex, getTileFrame } from './avatar-hash'
import { ZONES, resolveZoneForAgent, type AgentPhase } from './zone-config'

extend({ Container, Sprite })

interface RuntimeAgent {
  id: string
  tileIndex: number
  zone: AgentPhase
  x: number
  y: number
  targetX: number
  targetY: number
  alpha: number
  targetAlpha: number
}

interface LoadedTextures {
  dungeon: Texture
  creatures: Texture
}

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

export function DungeonScene({
  agents,
  className,
}: {
  agents: WorldAgent[]
  className?: string
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const textureCacheRef = useRef<Map<number, Texture>>(new Map())

  const [viewport, setViewport] = useState({ width: 1, height: 1 })
  const [textures, setTextures] = useState<LoadedTextures | null>(null)
  const [runtimeAgents, setRuntimeAgents] = useState<Record<string, RuntimeAgent>>({})
  const [fps, setFps] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    void Promise.all([
      Assets.load('/assets/rpg/dungeon.png') as Promise<Texture>,
      Assets.load('/assets/rpg/creatures.png') as Promise<Texture>,
    ]).then(([dungeon, creatures]) => {
      if (!active) return
      setTextures({ dungeon, creatures })
    }).catch((caught) => {
      const message = caught instanceof Error ? caught.message : 'Failed to load dungeon textures'
      if (active) setError(message)
    })

    return () => {
      active = false
    }
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
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setRuntimeAgents((previous) => {
      const next: Record<string, RuntimeAgent> = { ...previous }
      const activeIds = new Set(agents.map((agent) => agent.id))

      for (const id of Object.keys(next)) {
        if (!activeIds.has(id)) {
          next[id] = {
            ...next[id],
            targetAlpha: 0,
          }
        }
      }

      for (const agent of agents) {
        const zoneName = resolveZoneForAgent(agent.status, agent.phase)
        const zoneCenter = ZONES[zoneName].center
        const existing = next[agent.id]

        if (!existing) {
          const tileIndex = getAvatarTileIndex(agent.id)
          next[agent.id] = {
            id: agent.id,
            tileIndex,
            zone: zoneName,
            x: zoneCenter.x,
            y: zoneCenter.y,
            targetX: zoneCenter.x,
            targetY: zoneCenter.y,
            alpha: 0,
            targetAlpha: 1,
          }
          continue
        }

        next[agent.id] = {
          ...existing,
          zone: zoneName,
          targetX: zoneCenter.x,
          targetY: zoneCenter.y,
          targetAlpha: agent.status === 'completed' ? 0.7 : 1,
        }
      }

      return next
    })
  }, [agents])

  const worldScale = useMemo(
    () => Math.max(viewport.width / DUNGEON_WIDTH, viewport.height / DUNGEON_HEIGHT),
    [viewport.height, viewport.width],
  )

  const worldOffset = useMemo(() => ({
    x: Math.round((viewport.width - DUNGEON_WIDTH * worldScale) / 2),
    y: Math.round((viewport.height - DUNGEON_HEIGHT * worldScale) / 2),
  }), [viewport.height, viewport.width, worldScale])

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
      const target = previous[id]
      if (!target || target.targetAlpha !== 0) return previous

      const next = { ...previous }
      delete next[id]
      return next
    })
  }, [])

  return (
    <div className={className ?? 'absolute inset-0'} ref={hostRef}>
      {textures ? (
        <Application resizeTo={hostRef} antialias={false} backgroundAlpha={0}>
          <FpsProbe onSample={setFps} />
          <pixiContainer x={worldOffset.x} y={worldOffset.y} scale={{ x: worldScale, y: worldScale } as any}>
            <DungeonBackground texture={textures.dungeon} />
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
                  alpha={agent.alpha}
                  targetAlpha={agent.targetAlpha}
                  onFadeOutComplete={handleFadeOutComplete}
                />
              ))}
            </pixiContainer>
          </pixiContainer>
        </Application>
      ) : null}

      {error ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40 px-4 text-center text-xs font-mono text-white/90">
          {error}
        </div>
      ) : null}

      <div className="pointer-events-none absolute right-3 top-12 rounded-md border border-white/20 bg-black/45 px-2 py-1 text-[10px] font-mono uppercase text-white/90">
        fps {Math.round(fps)}
      </div>
    </div>
  )
}
