import type { FrontendModule } from '@/types'

export const modules: FrontendModule[] = [
  {
    name: 'agents',
    label: 'Agents Monitor',
    icon: 'Monitor',
    path: '/agents',
    component: () => import('@modules/agents/page'),
  },
  {
    name: 'telemetry',
    label: 'Telemetry Hub',
    icon: 'BarChart3',
    path: '/telemetry',
    component: () => import('@modules/telemetry/page'),
  },
  {
    name: 'services',
    label: 'Services Manager',
    icon: 'Server',
    path: '/services',
    component: () => import('@modules/services/page'),
  },
  {
    name: 'factory',
    label: 'Factory',
    icon: 'Warehouse',
    path: '/factory',
    component: () => import('@modules/factory/page'),
  },
  {
    name: 'commanders',
    label: 'Commanders',
    icon: 'Crown',
    path: '/commanders',
    component: () => import('@modules/commanders/page'),
  },
  {
    name: 'command-room',
    label: 'Command Room',
    icon: 'Server',
    path: '/command-room',
    component: () => import('@modules/command-room/page'),
  },
  {
    name: 'rpg',
    label: 'RPG',
    icon: 'Swords',
    path: '/rpg',
    component: () => import('@modules/rpg/page'),
  },
  {
    name: 'api-keys',
    label: 'Settings',
    icon: 'Settings',
    path: '/api-keys',
    component: () => import('@modules/api-keys/page'),
  },
]
