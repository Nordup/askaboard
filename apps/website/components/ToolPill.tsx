import { Fragment, type CSSProperties } from 'react'
import { Icon, LOCK_KEY, TOOLS, toolKeys, type ToolId } from './hero/tools'
import styles from './ToolPill.module.css'

/**
 * The app's tool pill (space/src/renderer/src/components/BoardControls.tsx, app.css .pill-bar and
 * .tool): the lock, then the tools in their groups. One copy for the hero (it works, at a bigger
 * scale) and the app shell (a picture: no handlers, no focus). The scale is --p, one app px in
 * CSS px; the caller's class sets it and the place.
 */
export function ToolPill({
  className,
  tool,
  lock,
  onTool,
  onLock
}: {
  className?: string
  tool: ToolId
  lock: boolean
  onTool?(tool: ToolId): void
  onLock?(): void
}) {
  const live = Boolean(onTool)
  const Button = live ? 'button' : 'span'
  return (
    <div className={className ? `${styles.pill} ${className}` : styles.pill} role={live ? 'toolbar' : undefined} aria-label={live ? 'Tools' : undefined} data-ui={live ? '' : undefined}>
      <Button
        className={lock ? styles.tool : `${styles.tool} ${styles.quiet}`}
        title={live ? `Keep tool ${LOCK_KEY}` : undefined}
        aria-label={live ? 'Keep tool' : undefined}
        aria-pressed={live ? lock : undefined}
        data-on={lock || undefined}
        onClick={onLock}
      >
        <Icon name={lock ? 'lock' : 'lockOpen'} />
      </Button>
      <span className={styles.divider} />
      {TOOLS.map((def, i) => (
        <Fragment key={def.id}>
          {i > 0 && TOOLS[i - 1].group !== def.group && <span className={styles.divider} />}
          <Button
            className={styles.tool}
            title={live ? `${def.label} ${toolKeys(def)}` : undefined}
            aria-label={live ? def.label : undefined}
            aria-pressed={live ? tool === def.id : undefined}
            data-on={tool === def.id || undefined}
            onClick={onTool ? () => onTool(def.id) : undefined}
            style={def.iconScale ? ({ '--icon-scale': def.iconScale } as CSSProperties) : undefined}
          >
            <Icon name={def.id} />
          </Button>
        </Fragment>
      ))}
    </div>
  )
}
