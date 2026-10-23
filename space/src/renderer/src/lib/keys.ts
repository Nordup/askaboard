/** True when a key event belongs to a text field, so canvas shortcuts must not fire. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
}
