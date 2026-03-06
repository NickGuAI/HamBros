export type AgentPhase = 'FORGE' | 'LIBRARY' | 'ARMORY' | 'DUNGEON' | 'THRONE_ROOM' | 'GATE'
export type RuntimePhase =
  | 'idle'
  | 'executing'
  | 'editing'
  | 'researching'
  | 'delegating'
  | 'thinking'
  | 'tool_use'
  | 'blocked'
  | 'completed'
export type RuntimeStatus = 'active' | 'idle' | 'stale' | 'completed'

export interface ZoneBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface ZoneCenter {
  x: number
  y: number
}

export interface ZoneConfig {
  name: AgentPhase
  label: string
  bounds: ZoneBounds
  center: ZoneCenter
  deskPos: ZoneCenter
  color: number
}

// Wander area covers the open interior (rows 2–9, cols 1–10 in pixel space)
export const IDLE_ZONE_BOUNDS = { x: 16, y: 32, width: 160, height: 96 }

// deskPos: pixel center where agent stands at their workstation (grid-aligned to 16px tiles)
//   FORGE      col 2  row 2  → (40, 32)  — forge torches at cols 2-3, row 2
//   LIBRARY    col 9  row 2  → (152, 32) — bookshelf  cols 9,   rows 1-2
//   ARMORY     col 2  row 8  → (40, 128) — iron bars  col  2,   rows 7-8
//   DUNGEON    col 9  row 8  → (152,128) — chest      col  9,   rows 7-8
//   THRONE_ROOM col 5 row 5  → (88, 88)  — altar      col  5,   row  5
//   GATE       col 6  row 5  → (96, 88)  — open floor wander start
export const ZONES: Record<AgentPhase, ZoneConfig> = {
  FORGE: {
    name: 'FORGE',
    label: 'Forge',
    bounds: { x: 16, y: 16, width: 72, height: 56 },
    center: { x: 52, y: 44 },
    deskPos: { x: 40, y: 32 },
    color: 0xFF6B35,
  },
  LIBRARY: {
    name: 'LIBRARY',
    label: 'Library',
    bounds: { x: 104, y: 16, width: 72, height: 56 },
    center: { x: 140, y: 44 },
    deskPos: { x: 152, y: 32 },
    color: 0x4ECDC4,
  },
  ARMORY: {
    name: 'ARMORY',
    label: 'Armory',
    bounds: { x: 16, y: 96, width: 72, height: 48 },
    center: { x: 52, y: 120 },
    deskPos: { x: 40, y: 128 },
    color: 0x45B7D1,
  },
  DUNGEON: {
    name: 'DUNGEON',
    label: 'Dungeon',
    bounds: { x: 104, y: 96, width: 72, height: 48 },
    center: { x: 140, y: 120 },
    deskPos: { x: 152, y: 128 },
    color: 0xAB47BC,
  },
  THRONE_ROOM: {
    name: 'THRONE_ROOM',
    label: 'Throne Room',
    bounds: { x: 48, y: 64, width: 96, height: 48 },
    center: { x: 96, y: 88 },
    deskPos: { x: 88, y: 88 },
    color: 0xFFD700,
  },
  GATE: {
    name: 'GATE',
    label: 'Gate',
    bounds: { x: 16, y: 16, width: 160, height: 144 },
    center: { x: 96, y: 88 },
    deskPos: { x: 96, y: 88 },
    color: 0x9E9E9E,
  },
}

export const ZONE_LIST: ZoneConfig[] = [
  ZONES.FORGE,
  ZONES.LIBRARY,
  ZONES.ARMORY,
  ZONES.DUNGEON,
  ZONES.THRONE_ROOM,
  ZONES.GATE,
]

export function resolveZoneForAgent(status: RuntimeStatus, phase: RuntimePhase): AgentPhase {
  if (status === 'completed') return 'THRONE_ROOM'
  if (status === 'stale') return 'GATE'

  switch (phase) {
    case 'tool_use':
    case 'executing':
      return 'FORGE'
    case 'thinking':
    case 'researching':
      return 'LIBRARY'
    case 'editing':
      return 'ARMORY'
    case 'delegating':
      return 'DUNGEON'
    case 'blocked':
    case 'idle':
      return 'GATE'
    case 'completed':
      return 'THRONE_ROOM'
    default:
      return 'GATE'
  }
}
