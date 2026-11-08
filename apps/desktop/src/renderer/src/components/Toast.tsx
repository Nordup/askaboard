import { useEffect } from 'react'
import { AlertCircle, CheckCircle2, VolumeX } from 'lucide-react'

/** One text action after the toast's text (the voice notice's "Set up local voice"). */
export interface ToastAction {
  label: string
  run(): void
}

/**
 * A short message at the bottom of the canvas: an error, "info" for a done action, or "warn" for a notice
 * that asks for a step (with an action). It hides itself after a few seconds, a toast with an action later.
 */
export function Toast({ message, kind = 'error', action, onDone }: { message: string; kind?: 'error' | 'info' | 'warn'; action?: ToastAction; onDone(): void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, action ? 9000 : 4500)
    return () => clearTimeout(timer)
  }, [message, action, onDone])
  return (
    <div className={`toast toast--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {kind === 'error' ? <AlertCircle size={14} strokeWidth={2} /> : kind === 'warn' ? <VolumeX size={14} strokeWidth={2} /> : <CheckCircle2 size={14} strokeWidth={2} />}
      {message}
      {action && (
        <button
          className="toast__action"
          onClick={() => {
            onDone()
            action.run()
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
