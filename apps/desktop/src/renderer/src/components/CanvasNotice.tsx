import type { ReactNode } from 'react'

interface CanvasNoticeProps {
  icon: ReactNode
  title: string
  body: ReactNode
  action?: { label: string; icon?: ReactNode; onClick(): void }
}

/** A quiet centred message on the canvas: no boards yet, a board that cannot load. */
export function CanvasNotice({ icon, title, body, action }: CanvasNoticeProps) {
  return (
    <div className="overlay-center">
      <div className="notice">
        <div className="notice__icon">{icon}</div>
        <div className="notice__title">{title}</div>
        <div className="notice__body">{body}</div>
        {action && (
          <button className="button-secondary" onClick={action.onClick}>
            {action.icon}
            {action.label}
          </button>
        )}
      </div>
    </div>
  )
}
