import { useEffect, useRef } from 'react'
import { useTick } from '@pixi/react'
import type { Texture } from 'pixi.js'
import type { WorldAgent } from './use-world-state'

interface AgentSpriteProps {
  id: string
  tileTexture: Texture
  x: number
  y: number
  targetX: number
  targetY: number
  status: WorldAgent['status']
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
  targetX,
  targetY,
  status,
  phaseChangedAt,
  completedAt,
  markedForRemoval = false,
  onFadeOutComplete,
}: AgentSpriteProps) {
  const spriteRef = useRef<any>(null)
  const currentRef = useRef({ x, y, alpha: 0, rotation: 0, scale: 1 })
  const targetRef = useRef({ x: targetX, y: targetY })
  const removalNotifiedRef = useRef(false)
  const bobSeedRef = useRef(hashSeed(id) % 2000)

  targetRef.current = { x: targetX, y: targetY }

  useEffect(() => {
    currentRef.current = { x, y, alpha: 0, rotation: 0, scale: 1 }
    removalNotifiedRef.current = false
    bobSeedRef.current = hashSeed(id) % 2000
  }, [id, x, y])

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

    currentRef.current.x += (targetRef.current.x - currentRef.current.x) * moveRate
    currentRef.current.y += (targetRef.current.y - currentRef.current.y) * moveRate

    let targetAlpha = 1
    let targetTint = 0xFFFFFF
    let targetRotation = 0
    let yOffset = 0
    let targetScale = 1

    if (status === 'active') {
      const phase = ((now + bobSeedRef.current) / 1000) * Math.PI
      yOffset = Math.sin(phase) * 2
      targetTint = 0xFFEE88
    } else if (status === 'idle') {
      targetAlpha = 0.7
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
      (markedForRemoval || status === 'completed') &&
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
