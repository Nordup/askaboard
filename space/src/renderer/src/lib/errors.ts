/** A readable message from an IPC error ("Error invoking remote method 'x': Error: msg" -> "msg"). */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
