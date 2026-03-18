import { type MutableRefObject, useEffect, useMemo, useRef } from 'react'
import { useTick } from '@pixi/react'
import { Rectangle, Texture } from 'pixi.js'
import { ROOM_WIDTH, ROOM_HEIGHT, TILE_SIZE, resolveMovement, isWalkable } from './room-layout'

// tiny-creatures tileset: 10 cols × 18 rows, 16×16px packed (no spacing)
const CREATURES_COLS = 10
// tile_0019 = col 9, row 1 — red creature sprite
const PLAYER_TILE = 19

// Player enters from door at bottom-center (row 9, cols 5-6)
const SPAWN_X = ROOM_WIDTH / 2      // 96
const SPAWN_Y = ROOM_HEIGHT - 28    // 148

const PLAYER_SPEED = 1.5
const PLAYER_RADIUS = 6
const PLAYER_POS_KEY = 'rpg:playerPos'
const SAVE_INTERVAL_FRAMES = 60

function makeFrame(source: Texture, index: number, cols: number): Texture {
  return new Texture({
    source: source.source,
    frame: new Rectangle(
      (index % cols) * TILE_SIZE,
      Math.floor(index / cols) * TILE_SIZE,
      TILE_SIZE,
      TILE_SIZE,
    ),
  })
}

interface PlayerSpriteProps {
  creaturesTexture: Texture
  sharedPosRef: MutableRefObject<{ x: number; y: number }>
  onInteract?: () => void
  frozen?: boolean
}

function isSpaceKey(key: string, code: string): boolean {
  return key === ' ' || key === 'spacebar' || code === 'Space'
}

function loadSavedPos(): { x: number; y: number } {
  try {
    const raw = localStorage.getItem(PLAYER_POS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'x' in parsed &&
        'y' in parsed &&
        typeof (parsed as { x: unknown }).x === 'number' &&
        typeof (parsed as { y: unknown }).y === 'number'
      ) {
        const { x, y } = parsed as { x: number; y: number }
        if (isWalkable(x, y, PLAYER_RADIUS)) return { x, y }
      }
    }
  } catch {
    // ignore parse errors
  }
  return { x: SPAWN_X, y: SPAWN_Y }
}

export function PlayerSprite({
  creaturesTexture,
  sharedPosRef,
  onInteract,
  frozen = false,
}: PlayerSpriteProps) {
  const spriteRef = useRef<any>(null)
  const posRef = useRef(loadSavedPos())
  const keysRef = useRef<Set<string>>(new Set())
  const interactDownRef = useRef(false)
  const frameCountRef = useRef(0)

  const texture = useMemo(
    () => makeFrame(creaturesTexture, PLAYER_TILE, CREATURES_COLS),
    [creaturesTexture],
  )

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (isSpaceKey(e.key.toLowerCase(), e.code)) {
        const tag = (e.target as HTMLElement)?.tagName
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          (e.target as HTMLElement)?.isContentEditable
        ) {
          return
        }
        if (e.repeat || interactDownRef.current) {
          return
        }
        interactDownRef.current = true
        if (!frozen) {
          onInteract?.()
        }
        e.preventDefault()
        return
      }
      keysRef.current.add(e.key.toLowerCase())
    }

    const onUp = (e: KeyboardEvent) => {
      if (isSpaceKey(e.key.toLowerCase(), e.code)) {
        interactDownRef.current = false
        return
      }
      keysRef.current.delete(e.key.toLowerCase())
    }

    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
    }
  }, [frozen, onInteract])

  useTick((ticker) => {
    const sprite = spriteRef.current
    if (!sprite) return

    if (!frozen) {
      const keys = keysRef.current
      let dx = 0
      let dy = 0

      if (keys.has('arrowleft') || keys.has('a')) dx -= PLAYER_SPEED * ticker.deltaTime
      if (keys.has('arrowright') || keys.has('d')) dx += PLAYER_SPEED * ticker.deltaTime
      if (keys.has('arrowup') || keys.has('w')) dy -= PLAYER_SPEED * ticker.deltaTime
      if (keys.has('arrowdown') || keys.has('s')) dy += PLAYER_SPEED * ticker.deltaTime

      if (dx !== 0 || dy !== 0) {
        if (dx !== 0 && dy !== 0) {
          const inv = 1 / Math.sqrt(2)
          dx *= inv
          dy *= inv
        }
        posRef.current = resolveMovement(posRef.current.x, posRef.current.y, dx, dy, PLAYER_RADIUS)
      }
    }

    sprite.x = Math.round(posRef.current.x)
    sprite.y = Math.round(posRef.current.y)
    sharedPosRef.current.x = posRef.current.x
    sharedPosRef.current.y = posRef.current.y

    frameCountRef.current += 1
    if (frameCountRef.current >= SAVE_INTERVAL_FRAMES) {
      frameCountRef.current = 0
      try {
        localStorage.setItem(PLAYER_POS_KEY, JSON.stringify(posRef.current))
      } catch {
        // ignore storage errors
      }
    }
  })

  return (
    <pixiSprite
      ref={spriteRef}
      texture={texture}
      x={SPAWN_X}
      y={SPAWN_Y}
      width={TILE_SIZE}
      height={TILE_SIZE}
      anchor={0.5}
      roundPixels
    />
  )
}
