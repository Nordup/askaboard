import { isFsCause } from '@shared/fs-causes'

/** A readable message from an IPC error ("Error invoking remote method 'x': Error: msg" -> "msg"). A file-system cause (FS_CAUSES) reads as a sentence. */
export function errorMessage(error: unknown): string {
  const message = ipcMessage(error)
  return isFsCause(message) ? `${message[0].toUpperCase()}${message.slice(1)}.` : message
}

/**
 * The learner's line for a failed action: "<lead>: <cause>." when main named a file-system cause (FS_CAUSES, main's
 * handle()), else fallback (by default the error's own message).
 */
export function failureText(lead: string, error: unknown, fallback = errorMessage(error)): string {
  const message = ipcMessage(error)
  return isFsCause(message) ? `${lead}: ${message}.` : fallback
}

function ipcMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
