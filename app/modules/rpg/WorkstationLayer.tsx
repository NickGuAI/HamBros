import { useMemo } from 'react'
import { Rectangle, Texture } from 'pixi.js'
import { ZONE_LIST } from './zone-config'

// workroom-tiles.png = kenney_tiny-dungeon/Tilemap/tilemap_packed.png
// 12 columns × 11 rows, 16×16 px per tile, no spacing (192 × 176 px total)
// frame(index): x = (index % 12) * 16,  y = floor(index / 12) * 16
//
// Verified tile content (app-assets/game/kenney_tiny-dungeon/index/tiles.md):
//   42 = torch — wall-mounted, lit (orange flame) ✓
//   43 = torch — floor-standing
//   44 = iron bars / window grate — top half
//   45 = iron bars / window grate — bottom half
//   48 = treasure chest — closed, top half
//   49 = treasure chest — closed, bottom half
//   57 = bookshelf — top half (blue/colored book spines) ✓
//   58 = bookshelf — bottom half
//  131 = altar / pedestal

interface TilePlacement {
  tileIndex: number
  dx: number  // offset from deskPos.x (anchor 0.5 on each sprite)
  dy: number  // offset from deskPos.y
}

// 2-tile-tall props (bookshelf, chest, bars): stacked top at dy=-8, bottom at dy=+8.
// Side-by-side props (torches): both at dy=0, dx=±8.
const STATION_TILES: Partial<Record<string, TilePlacement[]>> = {
  // Forge — smithing / executing: wall torch + floor torch = forge fire
  FORGE: [
    { tileIndex: 42, dx: -8, dy: 0 },
    { tileIndex: 43, dx:  8, dy: 0 },
  ],
  // Library — thinking / researching: bookshelf (stacked pair)
  LIBRARY: [
    { tileIndex: 57, dx: 0, dy: -8 },
    { tileIndex: 58, dx: 0, dy:  8 },
  ],
  // Armory — editing: iron bars (stacked pair)
  ARMORY: [
    { tileIndex: 44, dx: 0, dy: -8 },
    { tileIndex: 45, dx: 0, dy:  8 },
  ],
  // Dungeon — delegating: treasure chest (stacked pair)
  DUNGEON: [
    { tileIndex: 48, dx: 0, dy: -8 },
    { tileIndex: 49, dx: 0, dy:  8 },
  ],
  // Throne Room — completed: altar / pedestal
  THRONE_ROOM: [
    { tileIndex: 131, dx: 0, dy: 0 },
  ],
}

const TILE_COLS = 12
const TILE_SIZE = 16

function makeTileTexture(source: Texture, index: number): Texture {
  return new Texture({
    source: source.source,
    frame: new Rectangle(
      (index % TILE_COLS) * TILE_SIZE,
      Math.floor(index / TILE_COLS) * TILE_SIZE,
      TILE_SIZE,
      TILE_SIZE,
    ),
  })
}

interface WorkstationLayerProps {
  tilesTexture: Texture
}

export function WorkstationLayer({ tilesTexture }: WorkstationLayerProps) {
  const sprites = useMemo(() => {
    const result: Array<{ key: string; texture: Texture; x: number; y: number }> = []

    for (const zone of ZONE_LIST) {
      const placements = STATION_TILES[zone.name]
      if (!placements) continue
      for (let i = 0; i < placements.length; i++) {
        const p = placements[i]
        result.push({
          key: `${zone.name}-${i}`,
          texture: makeTileTexture(tilesTexture, p.tileIndex),
          x: zone.deskPos.x + p.dx,
          y: zone.deskPos.y + p.dy,
        })
      }
    }

    return result
  }, [tilesTexture])

  return (
    <pixiContainer>
      {sprites.map((s) => (
        <pixiSprite
          key={s.key}
          texture={s.texture}
          x={s.x}
          y={s.y}
          width={TILE_SIZE}
          height={TILE_SIZE}
          anchor={0.5}
          roundPixels
        />
      ))}
    </pixiContainer>
  )
}
