import { session as electronSession, type Session } from 'electron'

/**
 * Web permissions (decision D13): the app's pages ask for none. The board
 * reaches the clipboard through main (IPC), its full screen is the window's
 * own, and it plays sound with no permission. A world (untrusted code from a
 * learning folder) runs in a frame of the default session, so it gets none
 * either: no camera, microphone, location, notifications, pointer lock, MIDI,
 * HID, USB or serial. The stage session (stage-process.ts) uses this too.
 */
export function refusePermissions(ses: Session = electronSession.defaultSession): void {
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
}
