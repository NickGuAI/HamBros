import { NavLink } from 'react-router-dom'
import type { LucideProps } from 'lucide-react'
import {
  Monitor,
  BarChart3,
  Server,
  Settings,
  Warehouse,
  Crown,
  Swords,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const iconMap: Record<string, React.ComponentType<LucideProps>> = {
  Monitor,
  BarChart3,
  Server,
  Warehouse,
  Crown,
  Swords,
  Settings,
}

/** Short labels for mobile bottom nav */
const SHORT_LABELS: Record<string, string> = {
  agents: 'Agents',
  telemetry: 'Telemetry',
  services: 'Services',
  factory: 'Factory',
  commanders: 'Commanders',
  'command-room': 'Command',
  'api-keys': 'Settings',
}

interface NavItem {
  name: string
  label: string
  icon: string
  path: string
}

export function BottomNav({ modules }: { modules: NavItem[] }) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-20 flex items-stretch justify-around bg-washi-white border-t border-ink-border pb-[env(safe-area-inset-bottom,0px)] md:hidden">
      {modules.filter((mod) => mod.name !== 'commanders').map((mod) => {
        const Icon = iconMap[mod.icon]
        return (
          <NavLink
            key={mod.name}
            to={mod.path}
            className={({ isActive }) =>
              cn(
                'flex flex-1 flex-col items-center justify-center gap-1 pt-2.5 pb-2 text-sumi-mist transition-colors duration-300',
                isActive && 'text-sumi-black',
              )
            }
          >
            {({ isActive }) => (
              <>
                {Icon && <Icon size={24} />}
                <span className="text-[10px] uppercase tracking-wider">
                  {SHORT_LABELS[mod.name] ?? mod.label}
                </span>
                <span className={cn('block w-1 h-1 rounded-full', isActive ? 'bg-sumi-black' : 'bg-transparent')} />
              </>
            )}
          </NavLink>
        )
      })}
    </nav>
  )
}
