import { ModalPanel } from './ModalPanel'

/**
 * The trust question (decision U19): a modal panel when a folder opens whose boards hold worlds and that the learner
 * has not trusted, and from a paused world's "Trust folder…". Not now, Escape and a press on the backdrop leave the
 * folder untrusted; its worlds stay paused.
 */
export function TrustDialog({ onTrust, onClose }: { onTrust(): void; onClose(): void }) {
  return (
    <ModalPanel className="trust-dialog" label="Trust this folder?" onClose={onClose}>
      <div className="menu__title">Trust this folder?</div>
      <div className="menu__lede">Its boards have worlds: programs that run and can use the internet. Trust it only if you know where it came from.</div>
      <div className="menu__footer">
        <button className="btn-text" onClick={onClose}>
          Not now
        </button>
        <button className="btn-sm" data-action="trust-folder" onClick={onTrust}>
          Trust folder
        </button>
      </div>
    </ModalPanel>
  )
}
