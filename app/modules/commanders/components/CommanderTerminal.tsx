import { useEffect, useRef } from 'react'
import { TerminalSquare } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import { cn } from '@/lib/utils'
import type { CommanderSession, CommanderWsStatus } from '../hooks/useCommander'

export function CommanderTerminal({
  commander,
  lines,
  resetKey,
  wsStatus,
}: {
  commander: CommanderSession | null
  lines: string[]
  resetKey: number
  wsStatus: CommanderWsStatus
}) {
  const termRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const writtenLinesRef = useRef(0)

  useEffect(() => {
    if (!commander || !termRef.current) {
      return
    }

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

    terminal.open(termRef.current)
    fitAddon.fit()

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
    })
    resizeObserver.observe(termRef.current)

    terminalRef.current = terminal
    writtenLinesRef.current = 0

    return () => {
      resizeObserver.disconnect()
      terminal.dispose()
      terminalRef.current = null
      writtenLinesRef.current = 0
    }
  }, [commander?.id, resetKey])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) {
      return
    }

    if (writtenLinesRef.current > lines.length) {
      terminal.clear()
      writtenLinesRef.current = 0
    }

    const nextLines = lines.slice(writtenLinesRef.current)
    for (const line of nextLines) {
      terminal.writeln(line)
    }
    writtenLinesRef.current = lines.length
  }, [lines])

  return (
    <section className="h-full card-sumi overflow-hidden flex flex-col">
      <header className="px-4 py-3 border-b border-ink-border bg-washi-aged/60 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <TerminalSquare size={16} className="text-sumi-diluted shrink-0" />
          <h3 className="section-title truncate">Live Terminal Output</h3>
        </div>
        <span
          className={cn(
            'badge-sumi shrink-0',
            wsStatus === 'connected'
              ? 'badge-active'
              : wsStatus === 'connecting'
                ? 'badge-idle'
                : 'badge-stale',
          )}
        >
          {wsStatus}
        </span>
      </header>

      {commander ? (
        <div ref={termRef} className="flex-1 min-h-[20rem] bg-sumi-black" />
      ) : (
        <div className="flex-1 min-h-[20rem] flex items-center justify-center bg-washi-aged/20">
          <p className="text-sm text-sumi-diluted">Select a commander to view terminal output.</p>
        </div>
      )}
    </section>
  )
}
