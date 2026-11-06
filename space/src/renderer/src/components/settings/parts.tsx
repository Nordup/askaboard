import type { KeyboardEvent, ReactNode } from 'react'

/**
 * The shared parts of a Settings section (design-system.md, "Settings dialog"): a setting row is the name, a short
 * muted description under it and its one control at the right; lines (a problem with Retry, a status) go under it, and
 * a hairline parts two settings. The CSS parts are in the menu system (app.css, `.menu__setting`).
 */
export function SettingRow({
  name,
  description,
  children,
  lines,
  choice,
  data
}: {
  name: ReactNode
  description?: ReactNode
  /** The control at the right. */
  children?: ReactNode
  /** Lines under the row (`.menu__line`). */
  lines?: ReactNode
  /** The row is one choice of a group (role radio): a click or Enter chooses it; enabled false leaves it as it is. */
  choice?: { chosen: boolean; enabled: boolean; onChoose(): void }
  /** Data attributes on the setting (checks read them). */
  data?: Record<`data-${string}`, string>
}) {
  const choose = (): void => {
    if (choice?.enabled && !choice.chosen) choice.onChoose()
  }
  return (
    <div className="menu__setting" {...data}>
      <div
        className="menu__setting-row"
        {...(choice
          ? {
              role: 'radio',
              'aria-checked': choice.chosen,
              'aria-disabled': !choice.enabled,
              tabIndex: choice.enabled ? 0 : -1,
              onClick: choose,
              onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
                if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) {
                  event.preventDefault()
                  choose()
                }
              }
            }
          : {})}
      >
        {choice && <span className="menu__radio" aria-hidden="true" />}
        <div className="menu__setting-text">
          <span className="menu__name">{name}</span>
          {description && <span className="menu__desc">{description}</span>}
        </div>
        {children !== undefined && children !== null && <span className="menu__control">{children}</span>}
      </div>
      {lines}
    </div>
  )
}

/** A group heading inside a section (`.menu__heading`). */
export function SettingGroup({ heading, children }: { heading?: string; children: ReactNode }) {
  return (
    <section className="menu__group">
      {heading && <div className="menu__heading">{heading}</div>}
      {children}
    </section>
  )
}
