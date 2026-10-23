import { useEffect } from 'react'
import { AlertCircle } from 'lucide-react'

/** A short error message at the bottom of the canvas. It hides itself after a few seconds. */
export function Toast({ message, onDone }: { message: string; onDone(): void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, 4500)
    return () => clearTimeout(timer)
  }, [message, onDone])
  return (
    <div className="toast" role="alert">
      <AlertCircle size={14} strokeWidth={2} />
      {message}
    </div>
  )
}
