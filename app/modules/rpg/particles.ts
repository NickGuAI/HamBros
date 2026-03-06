import { Container, Graphics, Ticker } from 'pixi.js'

export type ParticleShape = 'sparks' | 'sparkle' | 'pulse' | 'ring'

export interface ParticleStyle {
  color: number
  shape: ParticleShape
}

interface ParticleBurstOptions {
  x: number
  y: number
  color: number
  shape: ParticleShape
  durationMs?: number
}

export function getParticleStyleForTool(toolName: string): ParticleStyle | null {
  const normalized = toolName.trim().toLowerCase()
  if (normalized === 'bash') {
    return { color: 0xFFCC00, shape: 'sparks' }
  }
  if (normalized === 'edit') {
    return { color: 0x4488FF, shape: 'sparkle' }
  }
  if (normalized === 'read') {
    return { color: 0x00FFFF, shape: 'pulse' }
  }
  if (normalized === 'agent') {
    return { color: 0xAA44FF, shape: 'ring' }
  }
  return null
}

export function drawParticleBurst(container: Container, options: ParticleBurstOptions): () => void {
  const graphics = new Graphics()
  const durationMs = options.durationMs ?? 600
  const startMs = Date.now()
  const radii = [0, 0.8, 1.2, 1.6, 2.1, 2.7, 3.2, 3.8]

  graphics.x = options.x
  graphics.y = options.y
  container.addChild(graphics)

  let stopped = false

  const cleanup = () => {
    if (stopped) {
      return
    }
    stopped = true
    Ticker.shared.remove(update)
    if (graphics.parent === container) {
      container.removeChild(graphics)
    }
    graphics.destroy()
  }

  const update = () => {
    const elapsedMs = Date.now() - startMs
    const progress = Math.min(1, elapsedMs / durationMs)
    const burstRadius = 4 + (16 * progress)
    const alpha = 1 - progress

    graphics.clear()
    graphics.alpha = alpha

    if (options.shape === 'sparks') {
      graphics.setStrokeStyle({ width: 1.5, color: options.color, alpha })
      for (let i = 0; i < 8; i += 1) {
        const angle = (Math.PI * 2 * i) / 8
        const inner = burstRadius * 0.35
        graphics.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner)
        graphics.lineTo(Math.cos(angle) * burstRadius, Math.sin(angle) * burstRadius)
      }
      graphics.stroke()
    } else if (options.shape === 'sparkle') {
      graphics.setStrokeStyle({ width: 1.4, color: options.color, alpha })
      graphics.moveTo(0, -burstRadius)
      graphics.lineTo(0, burstRadius)
      graphics.moveTo(-burstRadius, 0)
      graphics.lineTo(burstRadius, 0)
      graphics.moveTo(-burstRadius * 0.7, -burstRadius * 0.7)
      graphics.lineTo(burstRadius * 0.7, burstRadius * 0.7)
      graphics.moveTo(-burstRadius * 0.7, burstRadius * 0.7)
      graphics.lineTo(burstRadius * 0.7, -burstRadius * 0.7)
      graphics.stroke()
    } else if (options.shape === 'pulse') {
      graphics.circle(0, 0, burstRadius)
      graphics.fill({ color: options.color, alpha: alpha * 0.2 })
      graphics.setStrokeStyle({ width: 1.5, color: options.color, alpha })
      graphics.circle(0, 0, burstRadius)
      graphics.stroke()
    } else {
      graphics.setStrokeStyle({ width: 2, color: options.color, alpha })
      graphics.circle(0, 0, burstRadius)
      graphics.stroke()
      for (let i = 0; i < radii.length; i += 1) {
        const angle = ((Math.PI * 2) / radii.length) * i + progress * Math.PI
        const pointRadius = burstRadius * radii[i]
        graphics.circle(Math.cos(angle) * pointRadius, Math.sin(angle) * pointRadius, 1.2)
        graphics.fill({ color: options.color, alpha: alpha * 0.6 })
      }
    }

    if (progress >= 1) {
      cleanup()
    }
  }

  Ticker.shared.add(update)
  update()

  return cleanup
}
