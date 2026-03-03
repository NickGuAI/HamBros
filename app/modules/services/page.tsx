import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { SerializeAddon } from '@xterm/addon-serialize'
import '@xterm/xterm/css/xterm.css'
import { Server, Activity, Circle, X, ScrollText, RotateCw, Cpu, MemoryStick, AlertTriangle } from 'lucide-react'
import { useServices, useRestartService, useSystemMetrics } from '@/hooks/use-services'
import { cn, timeAgo } from '@/lib/utils'
import { getAccessToken } from '@/lib/api'
import { getWsBase } from '@/lib/api-base'
import { useIsMobile } from '@/hooks/use-is-mobile'
import type { ServiceInfo, ServiceStatus } from '@/types'

const STATUS_CLASSES: Record<ServiceStatus, string> = {
  running: 'badge-active',
  degraded: 'badge-idle',
  stopped: 'badge-stale',
}

function ServiceCard({
  service,
  selected,
  onSelect,
  onRestart,
  isRestarting,
}: {
  service: ServiceInfo
  selected: boolean
  onSelect: () => void
  onRestart: (name: string) => void
  isRestarting: boolean
}) {
  return (
    <div
      className={cn(
        'w-full card-sumi p-4 md:p-5 transition-all duration-300 ease-gentle',
        selected && 'ring-1 ring-sumi-black/10 shadow-ink-md',
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <button onClick={onSelect} className="min-w-0 flex-1 text-left">
          <div className="flex items-start gap-2">
            <Server size={16} className="mt-0.5 shrink-0 text-sumi-diluted" />
            <div className="min-w-0">
              <h3 className="font-mono text-sm text-sumi-black break-words">{service.name}</h3>
              <p className="mt-1 text-whisper text-sumi-mist font-mono break-all">
                {service.script}
              </p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-whisper text-sumi-diluted">
            <span className="font-mono text-sumi-black">Port: {service.port}</span>
            <span className="flex items-center gap-1.5">
              <Circle
                size={8}
                className={cn(
                  'fill-current',
                  service.healthy
                    ? 'text-accent-moss'
                    : service.listening
                      ? 'text-accent-persimmon'
                      : 'text-sumi-mist',
                )}
              />
              <span className="font-mono text-sumi-gray">
                {service.healthy ? 'healthy' : service.listening ? 'unhealthy' : 'stopped'}
              </span>
            </span>
            <span>Checked {timeAgo(service.lastChecked)}</span>
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-2 self-start">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onRestart(service.name)
            }}
            disabled={isRestarting}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-sumi-gray hover:bg-ink-wash disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            aria-label={`Restart ${service.name}`}
          >
            <RotateCw size={12} className={isRestarting ? 'animate-spin' : ''} />
            Restart
          </button>
          <span className={cn('badge-sumi', STATUS_CLASSES[service.status])}>
            {service.status}
          </span>
        </div>
      </div>
    </div>
  )
}

function LogViewer({
  serviceName,
  onClose,
  isMobileOverlay,
}: {
  serviceName: string
  onClose: () => void
  isMobileOverlay?: boolean
}) {
  const termRef = useRef<HTMLDivElement>(null)
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>(
    'connecting',
  )

  useEffect(() => {
    if (!termRef.current) {
      return
    }

    setWsStatus('connecting')

    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: false,
      disableStdin: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      theme: {
        background: '#1a1a1a',
        foreground: '#e0ddd5',
      },
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(new WebLinksAddon())
    terminal.loadAddon(new ClipboardAddon())
    terminal.loadAddon(new SearchAddon())
    const unicode11 = new Unicode11Addon()
    terminal.loadAddon(unicode11)
    terminal.unicode.activeVersion = '11'
    terminal.loadAddon(new SerializeAddon())

    // Let the browser handle paste natively (Ctrl+V / Cmd+V)
    terminal.attachCustomKeyEventHandler((event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'v' && event.type === 'keydown') {
        return false
      }
      return true
    })

    terminal.open(termRef.current)
    fitAddon.fit()

    let ws: WebSocket | null = null
    let resizeObserver: ResizeObserver | null = null
    let disposed = false

    const connect = async () => {
      const token = await getAccessToken()
      if (disposed) {
        return
      }

      const params = new URLSearchParams()
      if (token) {
        params.set('access_token', token)
      }
      const wsBase = getWsBase()
      const url = wsBase
        ? `${wsBase}/api/services/${encodeURIComponent(serviceName)}/logs?${params}`
        : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/services/${encodeURIComponent(serviceName)}/logs?${params}`

      ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'

      ws.onopen = () => {
        if (!disposed) {
          setWsStatus('connected')
        }
      }

      ws.onclose = () => {
        if (!disposed) {
          setWsStatus('disconnected')
        }
      }

      ws.onerror = () => {
        if (!disposed) {
          setWsStatus('disconnected')
        }
      }

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          terminal.write(new Uint8Array(event.data))
        } else {
          try {
            const msg = JSON.parse(event.data as string) as {
              type: string
              exitCode?: number
              signal?: number
            }
            if (msg.type === 'exit') {
              terminal.write(
                `\r\n[Log stream ended with code ${msg.exitCode ?? 'unknown'}]\r\n`,
              )
            }
          } catch {
            // Ignore invalid control messages
          }
        }
      }

      const container = termRef.current
      if (container) {
        resizeObserver = new ResizeObserver(() => {
          fitAddon.fit()
        })
        resizeObserver.observe(container)
      }
    }

    void connect()

    return () => {
      disposed = true
      ws?.close()
      resizeObserver?.disconnect()
      terminal.dispose()
    }
  }, [serviceName])

  return (
    <div className={isMobileOverlay ? 'terminal-overlay' : 'flex flex-col h-full'}>
      <div className="flex items-center justify-between px-5 py-3 border-b border-ink-border bg-washi-aged">
        <div className="flex items-center gap-2">
          <ScrollText size={16} className="text-sumi-diluted" />
          <span className="font-mono text-sm text-sumi-black">{serviceName}</span>
          <span
            className={cn(
              'badge-sumi',
              wsStatus === 'connected'
                ? 'badge-active'
                : wsStatus === 'connecting'
                  ? 'badge-idle'
                  : 'badge-stale',
            )}
          >
            {wsStatus}
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg hover:bg-ink-wash transition-colors"
          aria-label="Close log viewer"
        >
          <X size={16} className="text-sumi-diluted" />
        </button>
      </div>

      <div ref={termRef} className="flex-1 bg-sumi-black" />
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  const mb = bytes / (1024 * 1024)
  return `${mb.toFixed(0)} MB`
}

export default function ServicesPage() {
  const isMobile = useIsMobile()
  const { data: services, isLoading, error } = useServices()
  const { data: metrics } = useSystemMetrics()
  const restartMutation = useRestartService()
  const [selectedService, setSelectedService] = useState<string | null>(null)
  const total = services?.length ?? 0
  const runningCount = services?.filter((service) => service.status === 'running').length ?? 0

  function handleRestart(name: string) {
    if (restartMutation.isPending) return
    const confirmed = window.confirm(`Restart service "${name}"? This will re-execute its launch script.`)
    if (!confirmed) return

    restartMutation.mutate(name)
  }

  return (
    <div className="flex h-full">
      <div
        className={cn(
          'flex flex-col border-r border-ink-border transition-all duration-500 ease-gentle overflow-y-auto pb-20 md:pb-0',
          selectedService && !isMobile ? 'w-80' : 'w-full max-w-4xl mx-auto',
        )}
      >
        <div className="px-4 py-6 md:px-6 md:py-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-display text-display text-sumi-black">Services</h2>
              <p className="mt-2 text-sm text-sumi-diluted leading-relaxed">
                Deployed services discovered from launch scripts with live health checks.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <div className="card-sumi px-4 py-3 min-w-36 md:min-w-44">
                <div className="flex items-center gap-2 text-whisper text-sumi-diluted">
                  <Activity size={12} />
                  <span>Auto-refresh</span>
                </div>
                <p className="mt-1 text-sm text-sumi-black">Every 10s</p>
                <p className="text-whisper text-sumi-mist mt-1">
                  {runningCount}/{total} running
                </p>
              </div>
              {metrics && (
                <div className="card-sumi px-4 py-3 min-w-36 md:min-w-44">
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 text-whisper text-sumi-diluted">
                      <Cpu size={12} />
                      <span>CPU Load</span>
                      <span className="ml-auto font-mono text-sumi-black">
                        {metrics.loadAvg[0].toFixed(1)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-whisper text-sumi-diluted">
                      <MemoryStick size={12} />
                      <span>Memory</span>
                      <span className="ml-auto font-mono text-sumi-black">
                        {metrics.memUsedPercent}%
                      </span>
                    </div>
                    <p className="text-whisper text-sumi-mist">
                      {formatBytes(metrics.memTotalBytes - metrics.memFreeBytes)} / {formatBytes(metrics.memTotalBytes)}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {restartMutation.error && (
          <div className="mx-4 mb-3 flex items-start gap-2 rounded-lg bg-accent-vermillion/10 px-3 py-2 text-sm text-accent-vermillion">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>
              {restartMutation.error instanceof Error
                ? restartMutation.error.message
                : 'Failed to restart service'}
            </span>
          </div>
        )}

        <div className="px-4 pb-4">
          {isLoading ? (
            <div className="flex justify-center py-16">
              <div className="w-3 h-3 rounded-full bg-sumi-mist animate-breathe" />
            </div>
          ) : error ? (
            <div className="card-sumi p-5 text-sm text-accent-vermillion">
              Failed to load services.
            </div>
          ) : services?.length === 0 ? (
            <div className="card-sumi p-8 text-sm text-sumi-diluted text-center">
              No launch scripts with service ports were found.
            </div>
          ) : (
            <div className="space-y-3">
              {services?.map((service) => (
                <ServiceCard
                  key={`${service.name}:${service.port}`}
                  service={service}
                  selected={selectedService === service.name}
                  onSelect={() =>
                    setSelectedService(
                      selectedService === service.name ? null : service.name,
                    )
                  }
                  onRestart={handleRestart}
                  isRestarting={restartMutation.isPending && restartMutation.variables === service.name}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Log viewer: full-screen overlay on mobile, side panel on desktop */}
      {selectedService && (
        isMobile ? (
          <LogViewer
            serviceName={selectedService}
            onClose={() => setSelectedService(null)}
            isMobileOverlay
          />
        ) : (
          <div className="flex-1 animate-fade-in">
            <LogViewer
              serviceName={selectedService}
              onClose={() => setSelectedService(null)}
            />
          </div>
        )
      )}
    </div>
  )
}
