import { useMemo } from 'react'
import { Rectangle, Texture } from 'pixi.js'
import { FLOOR_LAYER, ROOM_COLS, TILE_SIZE } from './room-layout'

const TILEMAP_COLS = 12

function makeTileTexture(source: Texture, index: number): Texture {
  return new Texture({
    source: source.source,
    frame: new Rectangle(
      (index % TILEMAP_COLS) * TILE_SIZE,
      Math.floor(index / TILEMAP_COLS) * TILE_SIZE,
      TILE_SIZE,
      TILE_SIZE,
    ),
  })
}

interface TileMapLayerProps {
  tilesTexture: Texture
}

export function TileMapLayer({ tilesTexture }: TileMapLayerProps) {
  const tiles = useMemo(() => {
    const result: Array<{ key: string; texture: Texture; x: number; y: number }> = []
    for (let row = 0; row < FLOOR_LAYER.length; row++) {
      for (let col = 0; col < ROOM_COLS; col++) {
        const tileIndex = FLOOR_LAYER[row][col]
        result.push({
          key: `${col}-${row}`,
          texture: makeTileTexture(tilesTexture, tileIndex),
          x: col * TILE_SIZE,
          y: row * TILE_SIZE,
        })
      }
    }
    return result
  }, [tilesTexture])

  return (
    <pixiContainer>
      {tiles.map((t) => (
        <pixiSprite
          key={t.key}
          texture={t.texture}
          x={t.x}
          y={t.y}
          width={TILE_SIZE}
          height={TILE_SIZE}
          anchor={0}
          roundPixels
        />
      ))}
    </pixiContainer>
  )
}
