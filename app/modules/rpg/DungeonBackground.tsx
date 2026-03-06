import type { Texture } from 'pixi.js'

export const DUNGEON_WIDTH = 192
export const DUNGEON_HEIGHT = 176

export function DungeonBackground({ texture }: { texture: Texture }) {
  return (
    <pixiSprite
      texture={texture}
      x={0}
      y={0}
      width={DUNGEON_WIDTH}
      height={DUNGEON_HEIGHT}
      roundPixels
    />
  )
}
