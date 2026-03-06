import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import type { LucideProps } from 'lucide-react'
import {
  Monitor,
  BarChart3,
  Server,
  GitBranch,
  Settings,
  Warehouse,
  Crown,
  Swords,
  PanelLeftClose,
  PanelLeft,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { BottomNav } from '@/components/BottomNav'

const iconMap: Record<string, React.ComponentType<LucideProps>> = {
  Monitor,
  BarChart3,
  Server,
  GitBranch,
  Warehouse,
  Crown,
  Swords,
  Settings,
}

interface NavItem {
  name: string
  label: string
  icon: string
  path: string
}

export function Shell({
  modules,
  children,
}: {
  modules: NavItem[]
  children: React.ReactNode
}) {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div className="flex h-[100dvh] overflow-hidden">
      {/* Sidebar — hidden on mobile, visible from md up */}
      <aside
        className={cn(
          'hidden md:flex flex-col border-r border-ink-border bg-washi-aged transition-all duration-500 ease-gentle',
          collapsed ? 'w-16' : 'w-56',
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-6 border-b border-ink-border">
          {!collapsed && (
            <h1 className="font-display text-heading text-sumi-black tracking-wide">
              Hammurabi
            </h1>
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="p-2 rounded-lg hover:bg-ink-wash transition-colors duration-300"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-4 space-y-1 px-2">
          {modules.filter((mod) => mod.name !== 'commanders').map((mod) => {
            const Icon = iconMap[mod.icon]
            return (
              <NavLink
                key={mod.name}
                to={mod.path}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-300 ease-gentle',
                    isActive
                      ? 'bg-washi-white shadow-ink-sm text-sumi-black'
                      : 'text-sumi-gray hover:bg-ink-wash hover:text-sumi-black',
                    collapsed && 'justify-center px-0',
                  )
                }
              >
                {Icon && <Icon size={20} />}
                {!collapsed && (
                  <span className="text-sm font-body">{mod.label}</span>
                )}
              </NavLink>
            )
          })}
        </nav>

        {/* Footer */}
        {!collapsed && (
          <div className="px-4 py-4 border-t border-ink-border">
            <p className="text-whisper text-sumi-mist uppercase">Phase 2</p>
          </div>
        )}
      </aside>

      {/* Main content — add bottom padding on mobile for bottom nav + safe-area */}
      <main className="flex-1 overflow-y-auto bg-washi-white pb-[calc(4rem+env(safe-area-inset-bottom,0px))] md:pb-0">
        {children}
      </main>

      {/* Bottom navigation — visible only on mobile */}
      <BottomNav modules={modules} />
    </div>
  )
}
