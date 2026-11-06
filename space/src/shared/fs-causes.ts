/**
 * File-system failures in the learner's words. Main's handle() (main/index.ts) throws one of these as the whole message
 * when an action fails on a read-only folder, a full disk or an open folder that is gone; the renderer's failureText
 * (lib/errors.ts) puts the action's own lead before it ("Can't save: the disk is full."). No path, temp file or code reaches the learner.
 */
export const FS_CAUSES = {
  readOnly: 'this folder is read-only',
  full: 'the disk is full',
  gone: 'the folder was moved or deleted'
} as const

export type FsCause = (typeof FS_CAUSES)[keyof typeof FS_CAUSES]

const causes = new Set<string>(Object.values(FS_CAUSES))

export const isFsCause = (message: string): message is FsCause => causes.has(message)
