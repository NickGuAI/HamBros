export const AVATAR_TILE_SIZE = 16
export const AVATAR_TILE_COLUMNS = 10
export const AVATAR_TILE_ROWS = 18
export const AVATAR_TILE_COUNT = AVATAR_TILE_COLUMNS * AVATAR_TILE_ROWS

export interface TileFrame {
  index: number
  x: number
  y: number
  width: number
  height: number
}

export function djb2Hash(value: string): number {
  let hash = 5381
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash) + value.charCodeAt(i)
    hash >>>= 0
  }
  return hash >>> 0
}

export function getAvatarTileIndex(name: string): number {
  if (!name) return 0
  return djb2Hash(name) % AVATAR_TILE_COUNT
}

export function getTileFrame(index: number): TileFrame {
  const normalized = ((index % AVATAR_TILE_COUNT) + AVATAR_TILE_COUNT) % AVATAR_TILE_COUNT
  const column = normalized % AVATAR_TILE_COLUMNS
  const row = Math.floor(normalized / AVATAR_TILE_COLUMNS)
  return {
    index: normalized,
    x: column * AVATAR_TILE_SIZE,
    y: row * AVATAR_TILE_SIZE,
    width: AVATAR_TILE_SIZE,
    height: AVATAR_TILE_SIZE,
  }
}
