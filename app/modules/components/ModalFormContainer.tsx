import { type ReactNode, useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ModalFormContainerProps {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  contentClassName?: string
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    if (element.getAttribute('aria-hidden') === 'true') {
      return false
    }
    const styles = window.getComputedStyle(element)
    if (styles.visibility === 'hidden' || styles.display === 'none') {
      return false
    }
    return element.getClientRects().length > 0
  })
}

export function ModalFormContainer({
  open,
  title,
  onClose,
  children,
  contentClassName,
}: ModalFormContainerProps) {
  const mobileDialogRef = useRef<HTMLDivElement | null>(null)
  const desktopDialogRef = useRef<HTMLDivElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open || typeof window === 'undefined') {
      return
    }

    const previousActiveElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const isDesktop = window.matchMedia('(min-width: 768px)').matches
    const dialog = isDesktop ? desktopDialogRef.current : mobileDialogRef.current
    if (!dialog) {
      return
    }

    const focusableElements = getFocusableElements(dialog)
    ;(focusableElements[0] ?? dialog).focus()

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }

      if (event.key !== 'Tab') {
        return
      }

      const elements = getFocusableElements(dialog)
      if (elements.length === 0) {
        event.preventDefault()
        return
      }

      const first = elements[0]
      const last = elements[elements.length - 1]
      if (!first || !last) {
        return
      }

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
        return
      }

      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previousActiveElement?.focus()
    }
  }, [open])

  if (!open) {
    return null
  }

  return (
    <>
      <button
        type="button"
        className="sheet-backdrop visible"
        aria-label={`Close ${title}`}
        onClick={onClose}
      />

      <div className="md:hidden">
        <div
          ref={mobileDialogRef}
          className="sheet visible"
          role="dialog"
          aria-modal="true"
          aria-label={title}
          tabIndex={-1}
        >
          <div className="sheet-handle">
            <div className="sheet-handle-bar" />
          </div>
          <div className="px-5 pb-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 className="font-display text-heading text-sumi-black">{title}</h3>
              <button
                type="button"
                onClick={onClose}
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-ink-border p-1 text-sumi-diluted hover:text-sumi-black hover:border-ink-border-hover transition-colors"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>
            <div className={cn('space-y-3', contentClassName)}>{children}</div>
          </div>
        </div>
      </div>

      <div className="fixed inset-0 z-[9999] hidden md:flex items-center justify-center p-5">
        <div
          ref={desktopDialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className={cn(
            'card-sumi w-full max-w-3xl max-h-[85dvh] overflow-y-auto p-5',
            contentClassName,
          )}
          tabIndex={-1}
        >
          <div className="mb-4 flex items-center justify-between gap-3 border-b border-ink-border pb-3">
            <h3 className="font-display text-heading text-sumi-black">{title}</h3>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-ink-border p-1 text-sumi-diluted hover:text-sumi-black hover:border-ink-border-hover transition-colors"
              aria-label="Close"
            >
              <X size={14} />
            </button>
          </div>
          <div className="space-y-3">{children}</div>
        </div>
      </div>
    </>
  )
}
