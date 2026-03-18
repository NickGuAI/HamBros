import { type MutableRefObject, useEffect, useRef } from 'react'
import { useTick } from '@pixi/react'
import type { Texture } from 'pixi.js'
import type { WorldAgent } from './use-world-state'
import { isWalkable } from './room-layout'

const DEFAULT_AGENT_RADIUS = 6

interface RuntimeAgentPosition {
  x: number
  y: number
  markedForRemoval?: boolean
}

interface AgentSpriteProps {
  id: string
  tileTexture: Texture
  x: number
  y: number
  agentRadius?: number
  runtimeAgentsRef: MutableRefObject<Record<string, RuntimeAgentPosition>>
  waypoints: Array<{ x: number; y: number }>
  status: WorldAgent['status']
  role?: WorldAgent['role']
  phaseChangedAt?: number
  completedAt?: number
  markedForRemoval?: boolean
  onFadeOutComplete?: (id: string) => void
}

function hashSeed(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return hash
}

export function AgentSprite({
  id,
  tileTexture,
  x,
  y,
  agentRadius = DEFAULT_AGENT_RADIUS,
  runtimeAgentsRef,
  waypoints,
  status,
  role,
  phaseChangedAt,
  completedAt,
  markedForRemoval = false,
  onFadeOutComplete,
}: AgentSpriteProps) {
  const isCommander = role === 'commander' || id.startsWith('commander-')
  const baseScale = isCommander ? 1.3 : 1
  const spriteRef = useRef<any>(null)
  const currentRef = useRef({ x, y, alpha: 0, rotation: 0, scale: baseScale })
  const waypointsRef = useRef<Array<{ x: number; y: number }>>(waypoints)
  const removalNotifiedRef = useRef(false)
  const bobSeedRef = useRef(hashSeed(id) % 2000)

  // Sync waypoints ref only when the path changes (new destination computed)
  useEffect(() => {
    waypointsRef.current = waypoints
  }, [waypoints])

  useEffect(() => {
    currentRef.current = { x, y, alpha: 0, rotation: 0, scale: baseScale }
    removalNotifiedRef.current = false
    bobSeedRef.current = hashSeed(id) % 2000
  }, [id, x, y, baseScale])

  useTick((ticker) => {
    const sprite = spriteRef.current
    if (!sprite) {
      return
    }

    const now = performance.now()
    const moveRate = status === 'idle'
      ? Math.min(1, 0.04 * ticker.deltaTime)
      : Math.min(1, 0.09 * ticker.deltaTime)
    const blendRate = Math.min(1, 0.18 * ticker.deltaTime)

    // Advance waypoint queue: when close enough to the current waypoint, shift it off
    const wps = waypointsRef.current
    if (wps.length > 1) {
      const wp = wps[0]
      const dx = wp.x - currentRef.current.x
      const dy = wp.y - currentRef.current.y
      if (dx * dx + dy * dy <= 1) {
        waypointsRef.current = wps.slice(1)
      }
    }
    const target = waypointsRef.current[0] ?? { x: currentRef.current.x, y: currentRef.current.y }
    currentRef.current.x += (target.x - currentRef.current.x) * moveRate
    currentRef.current.y += (target.y - currentRef.current.y) * moveRate

    const selfRuntimeAgent = runtimeAgentsRef.current[id]
    if (selfRuntimeAgent) {
      selfRuntimeAgent.x = currentRef.current.x
      selfRuntimeAgent.y = currentRef.current.y
    }

    const minDistance = agentRadius * 2
    const minDistanceSquared = minDistance * minDistance
    for (const [otherId, other] of Object.entries(runtimeAgentsRef.current)) {
      if (otherId === id || other.markedForRemoval) continue

      const dx = currentRef.current.x - other.x
      const dy = currentRef.current.y - other.y
      const distanceSquared = dx * dx + dy * dy
      if (distanceSquared >= minDistanceSquared) continue

      let nx = 1
      let ny = 0
      let push = minDistance / 2

      if (distanceSquared > 0) {
        const distance = Math.sqrt(distanceSquared)
        nx = dx / distance
        ny = dy / distance
        push = (minDistance - distance) / 2
      }

      const nextX = currentRef.current.x + nx * push
      const nextY = currentRef.current.y + ny * push
      if (!isWalkable(nextX, nextY, agentRadius)) continue

      currentRef.current.x = nextX
      currentRef.current.y = nextY
    }

    if (selfRuntimeAgent) {
      selfRuntimeAgent.x = currentRef.current.x
      selfRuntimeAgent.y = currentRef.current.y
    }

    let targetAlpha = 1
    let targetTint = 0xFFFFFF
    let targetRotation = 0
    let yOffset = 0
    let targetScale = baseScale

    if (status === 'active' || isCommander) {
      const phase = ((now + bobSeedRef.current) / 1000) * Math.PI
      yOffset = Math.sin(phase) * 2
    }

    if (status === 'active') {
      targetTint = 0xFFEE88
    } else if (status === 'idle') {
      targetAlpha = 0.75
      targetTint = 0x8E8E8E
    } else if (status === 'stale') {
      targetAlpha = 0.5
      targetTint = 0x7A7A7A
      targetRotation = Math.PI / 2
    } else if (status === 'completed') {
      const completionStart = completedAt ?? now
      const elapsedMs = Math.max(0, now - completionStart)
      const fade = Math.max(0, 1 - (elapsedMs / 60000))
      const pulse = 1 + (Math.sin((elapsedMs / 1000) * Math.PI * 4) * 0.18 * fade)
      targetAlpha = fade
      targetTint = 0xFFD34D
      targetScale *= pulse
    }

    if (isCommander) {
      targetTint = 0xFFD700
    }

    if (phaseChangedAt !== undefined) {
      const elapsed = now - phaseChangedAt
      if (elapsed >= 0 && elapsed <= 200) {
        const t = elapsed / 200
        const popScale = t < 0.5
          ? 1 + (t * 1)
          : 1.5 - ((t - 0.5) * 1)
        targetScale *= popScale
      }
    }

    if (markedForRemoval && status !== 'completed') {
      targetAlpha = 0
    }

    currentRef.current.alpha += (targetAlpha - currentRef.current.alpha) * blendRate
    currentRef.current.rotation += (targetRotation - currentRef.current.rotation) * blendRate
    currentRef.current.scale += (targetScale - currentRef.current.scale) * blendRate

    sprite.x = Math.round(currentRef.current.x)
    sprite.y = Math.round(currentRef.current.y + yOffset)
    sprite.alpha = Math.max(0, Math.min(1, currentRef.current.alpha))
    sprite.rotation = currentRef.current.rotation
    sprite.scale.set(currentRef.current.scale)
    sprite.tint = targetTint

    if (
      markedForRemoval &&
      sprite.alpha <= 0.02 &&
      !removalNotifiedRef.current
    ) {
      removalNotifiedRef.current = true
      onFadeOutComplete?.(id)
    }
  })

  return (
    <pixiSprite
      ref={spriteRef}
      texture={tileTexture}
      x={x}
      y={y}
      width={16}
      height={16}
      anchor={0.5}
      roundPixels
    />
  )
}
