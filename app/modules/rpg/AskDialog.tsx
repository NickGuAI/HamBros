import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { AskQuestion } from '@/types'
import type { PendingAsk } from './use-session-ws'

interface AskDialogProps {
  pendingAsk: PendingAsk | null
  disabled?: boolean
  onSubmit: (toolId: string, answers: Record<string, string[]>) => boolean
}

function buildInitialAnswers(questions: AskQuestion[]): Record<string, string[]> {
  const answers: Record<string, string[]> = {}
  for (const question of questions) {
    answers[question.header] = []
  }
  return answers
}

export function AskDialog({ pendingAsk, disabled = false, onSubmit }: AskDialogProps) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [error, setError] = useState<string | null>(null)

  const questions = pendingAsk?.questions ?? []

  useEffect(() => {
    if (!pendingAsk) {
      setAnswers({})
      setError(null)
      return
    }

    setAnswers(buildInitialAnswers(pendingAsk.questions))
    setError(null)
  }, [pendingAsk])

  const readyToSubmit = useMemo(() => {
    if (!pendingAsk) {
      return false
    }
    if (questions.length === 0) {
      return true
    }
    return questions.every((question) => (answers[question.header] ?? []).length > 0)
  }, [answers, pendingAsk, questions])

  if (!pendingAsk) {
    return null
  }

  const setSingle = (header: string, value: string) => {
    setAnswers((previous) => ({
      ...previous,
      [header]: [value],
    }))
  }

  const toggleMulti = (header: string, value: string) => {
    setAnswers((previous) => {
      const current = previous[header] ?? []
      return {
        ...previous,
        [header]: current.includes(value)
          ? current.filter((item) => item !== value)
          : [...current, value],
      }
    })
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const ok = onSubmit(pendingAsk.toolId, answers)
    if (!ok) {
      setError('Unable to send answer. Check connection and retry.')
    }
  }

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/35 p-4 backdrop-blur-[1px]">
      <form onSubmit={submit} className="w-full max-w-xl rounded-xl border border-emerald-300/35 bg-zinc-950/95 p-4 text-white shadow-2xl">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="font-mono text-xs uppercase tracking-[0.08em] text-emerald-100">ask user question</h2>
          <span className="rounded border border-emerald-300/30 bg-emerald-300/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-100">
            tool {pendingAsk.toolId.slice(0, 8)}
          </span>
        </div>

        <div className="space-y-4">
          {questions.length > 0 ? questions.map((question) => (
            <section key={question.header} className="rounded-lg border border-white/10 bg-black/35 p-3">
              <p className="font-semibold text-sm text-white">{question.question}</p>
              <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.08em] text-white/50">{question.header}</p>

              <div className="mt-3 space-y-2">
                {question.options.map((option) => {
                  const selected = (answers[question.header] ?? []).includes(option.label)
                  if (question.multiSelect) {
                    return (
                      <label key={option.label} className="flex cursor-pointer items-start gap-2 rounded border border-white/10 bg-black/30 px-2 py-1.5 text-sm hover:border-white/25">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleMulti(question.header, option.label)}
                          className="mt-0.5"
                          disabled={disabled}
                        />
                        <span>
                          <span className="block">{option.label}</span>
                          {option.description ? <span className="text-xs text-white/60">{option.description}</span> : null}
                        </span>
                      </label>
                    )
                  }

                  return (
                    <label key={option.label} className="flex cursor-pointer items-start gap-2 rounded border border-white/10 bg-black/30 px-2 py-1.5 text-sm hover:border-white/25">
                      <input
                        type="radio"
                        name={question.header}
                        checked={selected}
                        onChange={() => setSingle(question.header, option.label)}
                        className="mt-0.5"
                        disabled={disabled}
                      />
                      <span>
                        <span className="block">{option.label}</span>
                        {option.description ? <span className="text-xs text-white/60">{option.description}</span> : null}
                      </span>
                    </label>
                  )
                })}
              </div>
            </section>
          )) : (
            <div className="rounded-lg border border-white/10 bg-black/35 p-3 text-sm text-white/80">
              This tool did not include selectable options. Submit to acknowledge.
            </div>
          )}
        </div>

        <div className="mt-4 flex items-center justify-between gap-2">
          {error ? <p className="text-xs text-red-300">{error}</p> : <div />}
          <button
            type="submit"
            disabled={disabled || !readyToSubmit}
            className="rounded-md border border-emerald-300/35 bg-emerald-300/15 px-3 py-1.5 font-mono text-xs uppercase tracking-[0.08em] text-emerald-100 transition enabled:hover:bg-emerald-300/25 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Submit Answer
          </button>
        </div>
      </form>
    </div>
  )
}
