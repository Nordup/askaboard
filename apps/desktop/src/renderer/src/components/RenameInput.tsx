import { useRef, useState } from 'react'

/** The board name as a field: Enter or a blur keeps the new name, Escape keeps the old one (a sidebar row, or the top bar with the sidebar hidden). */
export function RenameInput({ initial, className = 'board-row__input', onCommit, onCancel }: { initial: string; className?: string; onCommit(name: string): void; onCancel(): void }) {
  const [value, setValue] = useState(initial)
  const done = useRef(false)
  const finish = (commit: boolean): void => {
    if (done.current) return
    done.current = true
    const name = value.trim()
    if (commit && name && name !== initial) onCommit(name)
    else onCancel()
  }
  return (
    <input
      className={className}
      value={value}
      autoFocus
      spellCheck={false}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') finish(true)
        else if (event.key === 'Escape') finish(false)
      }}
      onBlur={() => finish(true)}
    />
  )
}
