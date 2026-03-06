// room-layout.ts — 25×25 tile grid from fun_map.tmx
// Source: app-assets/game/kenney_tiny-dungeon/pre-mad-maps/fun_map.tmx
// Tileset: kenney_tiny-dungeon/Tiled/sampleSheet.tsx (firstgid=1, spacing=1px)
// Packed tileset: workroom-tiles.png (tilemap_packed.png, no spacing, 12 cols)
// Frame formula for workroom-tiles.png: x = (index % 12) * 16, y = floor(index / 12) * 16
//
// TMX uses GIDs (1-based). FLOOR_LAYER stores tile indices = GID - 1.
//
// Key tiles (verified visually):
//   tile 0  (GID  1) = brownish dungeon floor — open area top room ✓
//   tile 12 (GID 13) = rest room floor — left walled room (cols 1-4, rows 6-21) ✓
//   tile 20 (GID 21) = door gap — passage between top and bottom room ✓
//   tile 49 (GID 50) = orange/dungeon floor — lower room + open area ✓
//   tile 72 (GID 73) = table  — regular agent workstation ✓
//   tile 74 (GID 75) = anvil  — factory agent workstation ✓

export const TILE_SIZE = 16
export const ROOM_COLS = 25
export const ROOM_ROWS = 25
export const ROOM_WIDTH  = ROOM_COLS * TILE_SIZE  // 400
export const ROOM_HEIGHT = ROOM_ROWS * TILE_SIZE  // 400

// Tile indices derived from fun_map.tmx CSV (each value = GID − 1)
// prettier-ignore
export const FLOOR_LAYER: number[][] = [
  // row 0 — top room: tables (72) + anvils (74), floor (0), border walls (57/59)
  [57,72, 0, 0,72, 0, 0,72, 0, 0,72, 0, 0,72, 0, 0,74, 0, 0,74, 0, 0,74, 0,59],
  // row 1 — all floor
  [57, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,59],
  // row 2 — tables + anvils
  [57,72, 0, 0,72, 0, 0,72, 0, 0,72, 0, 0,72, 0, 0,74, 0, 0,74, 0, 0,74, 0,59],
  // row 3 — all floor
  [57, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,59],
  // row 4 — tables + anvils
  [57,72, 0, 0,72, 0, 0,72, 0, 0,72, 0, 0,72, 0, 0,74, 0, 0,74, 0, 0,74, 0,59],
  // row 5 — horizontal wall; door gaps (tile 20) at cols 10–13, floor gap (tile 0) at cols 2–3
  [36,37, 0, 0,37,37,37,37,37,37,20, 0, 0,20,37,37,37,37,37,37,37,37,37,37,38],
  // row 6 — rest room left (tile 12), dungeon corridor right (all orange floor); right desks (72) at col 19
  [36,12,12,12,12,59,49,49,49,49,49,49,49,49,49,49,49,49,36,72, 0, 0,72,59,52],
  // row 7
  [36,12,12,12,12,59,49,49,49,49,49,49,49,49,49,49,49,49,36, 0, 0, 0, 0,59,48],
  // row 8
  [36,12,12,12,12,59,49,49,49,49,49,49,49,49,49,49,49,49,36,72, 0, 0,72,59,49],
  // row 9
  [36,12,12,12,12,59,49,49,49,49,49,49,49,49,49,49,49,49,36, 0, 0, 0, 0,59,49],
  // row 10 — dual pool border
  [36,12,12,12,12,59,69,70,54,70,71,49,49,69,70,54,70,71,36,72, 0, 0,72,59,49],
  // row 11
  [36,12,12,12,12,59,81,49,49,49,81,49,49,81,49,49,49,83,36, 0, 0, 0, 0,59,49],
  // row 12
  [36,12,12,12,12,59,81,49,49,49,81,49,49,81,49,49,49,83,36,72, 0, 0,72,59,49],
  // row 13
  [36,12,12,12,12,59,81,49,49,49,81,49,49,81,49,49,49,83,36, 0, 0, 0, 0,59,52],
  // row 14
  [36,12,12,12,12,59,81,49,49,49,81,49,49,81,49,49,49,83,36,72, 0, 0,72,59,49],
  // row 15
  [36,12,12,12,12,59,81,49,49,49,81,49,49,81,49,49,49,83,36,38, 0, 0,36,59,49],
  // row 16 — rest room continues full height; pool sides open into lower area
  [36,12,12,12,12,59,81,49,49,49,81,49,49,81,49,49,49,83,49,49,49,49,49,49,49],
  [36,12,12,12,12,59,81,49,49,49,81,49,49,81,49,49,49,83,49,49,49,49,49,49,49],
  [36,12,12,12,12,59,81,49,49,49,81,49,49,81,49,49,49,83,49,49,49,49,49,49,49],
  [36,12,12,12,12,59,81,49,49,49,81,49,49,81,49,49,49,83,49,49,49,49,49,49,49],
  [36,12,12,12,12,59,81,49,49,49,81,49,49,81,49,49,49,83,49,49,49,49,49,49,49],
  // row 21 — bottom wall of rest room; pool bottom (93-95)
  [36,37,37,37,37,38,93,94,94,94,95,49,49,93,94,94,94,95,49,49,49,49,49,49,49],
  // rows 22-24 — open lower area
  [49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49],
  [49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49],
  [49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49],
]

// Walkable tile indices:
//   tile 0  = brownish floor (top room)
//   tile 12 = rest room floor (left walled room — idle agents rest here)
//   tile 20 = door gap
//   tile 49 = orange floor (lower room / open area)
const WALKABLE_TILES = new Set([0, 12, 20, 49])

export const WALKABLE_GRID: boolean[][] = FLOOR_LAYER.map(
  (row) => row.map((tileIndex) => WALKABLE_TILES.has(tileIndex)),
)

// ---------------------------------------------------------------------------
// Workstation spots — pixel centers one tile to the RIGHT of each prop tile.
// Only spots whose right-neighbour is a walkable floor tile are included.
// ---------------------------------------------------------------------------

/** pixel center of tile (col, row) */
function tc(col: number, row: number): { x: number; y: number } {
  return { x: col * TILE_SIZE + TILE_SIZE / 2, y: row * TILE_SIZE + TILE_SIZE / 2 }
}

// Regular agent desks — next to table tiles (GID 73 = tile 72)
// Tables appear in rows 0,2,4 at cols 1,4,7,10,13
// Tables appear in rows 6,8,10,12,14 at col 19 only (left-side tables removed in updated map)
export const TABLE_SPOTS: Array<{ x: number; y: number }> = [
  tc( 2, 0), tc( 5, 0), tc( 8, 0), tc(11, 0), tc(14, 0),
  tc( 2, 2), tc( 5, 2), tc( 8, 2), tc(11, 2), tc(14, 2),
  tc( 2, 4), tc( 5, 4), tc( 8, 4), tc(11, 4), tc(14, 4),
  tc(20, 6),
  tc(20, 8),
  tc(20,10),
  tc(20,12),
  tc(20,14),
]

// Factory agent desks — next to anvil tiles (GID 75 = tile 74)
// Anvils appear in rows 0,2,4 at cols 16,19,22
export const ANVIL_SPOTS: Array<{ x: number; y: number }> = [
  tc(17, 0), tc(20, 0), tc(23, 0),
  tc(17, 2), tc(20, 2), tc(23, 2),
  tc(17, 4), tc(20, 4), tc(23, 4),
]

// Idle agent spots — fixed positions in the left rest room (tile 12 floor, cols 1-4, rows 6-21)
// Arranged in a 2-column grid at cols 2 and 3, spaced every 2 rows
export const IDLE_SPOTS: Array<{ x: number; y: number }> = [
  tc(2, 7), tc(3, 7),
  tc(2, 9), tc(3, 9),
  tc(2,11), tc(3,11),
  tc(2,13), tc(3,13),
  tc(2,15), tc(3,15),
  tc(2,17), tc(3,17),
  tc(2,19), tc(3,19),
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isWalkable(x: number, y: number, radius = 6): boolean {
  const corners = [
    { cx: x - radius, cy: y - radius },
    { cx: x + radius, cy: y - radius },
    { cx: x - radius, cy: y + radius },
    { cx: x + radius, cy: y + radius },
  ]
  for (const { cx, cy } of corners) {
    const col = Math.floor(cx / TILE_SIZE)
    const row = Math.floor(cy / TILE_SIZE)
    if (col < 0 || col >= ROOM_COLS || row < 0 || row >= ROOM_ROWS) return false
    if (!WALKABLE_GRID[row][col]) return false
  }
  return true
}

export function resolveMovement(
  x: number,
  y: number,
  dx: number,
  dy: number,
  radius = 6,
): { x: number; y: number } {
  if (isWalkable(x + dx, y + dy, radius)) return { x: x + dx, y: y + dy }
  if (dx !== 0 && isWalkable(x + dx, y, radius)) return { x: x + dx, y }
  if (dy !== 0 && isWalkable(x, y + dy, radius)) return { x, y: y + dy }
  return { x, y }
}
