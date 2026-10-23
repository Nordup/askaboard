import { useEffect } from 'react'
import { AlertCircle, CheckCircle2 } from 'lucide-react'

/** A short message at the bottom of the canvas: an error, or "info" for a done action. It hides itself after a few seconds. */
export function Toast({ message, kind = 'error', onDone }: { message: string; kind?: 'error' | 'info'; onDone(): void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, 4500)
    return () => clearTimeout(timer)
  }, [message, onDone])
  return (
    <div className={`toast toast--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {kind === 'error' ? <AlertCircle size={14} strokeWidth={2} /> : <CheckCircle2 size={14} strokeWidth={2} />}
      {message}
    </div>
  )
}
