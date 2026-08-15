import Foundation

/// Whether the session the learner has just left may be closed on the server
/// now, or must wait for the live voice call still running inside it.
///
/// A call binds to the session it was started in for its whole life, and the
/// learner is free to wander into other sessions while it runs (the pill marks
/// where the call is). Closing the call session on that switch is what
/// `POST /v1/sessions/{id}/close` means to the server — freeze the transcript,
/// write the episode — and `uq_episodes_session` makes the first freeze the
/// only one the session will ever get. A call that is still speaking into that
/// transcript would be cut out of its own episode.
///
/// So the close is *deferred*, not dropped: the id is remembered, and the call
/// ending is what sends it. This type is the decision alone — no store, no
/// network — so the whole table can be tested as values.
///
/// | Event | Close of the outgoing session |
/// |---|---|
/// | Switch away from the call session, call live | deferred |
/// | Switch away, no call live | sent now |
/// | Call ends while its session is not visible | the deferred close is sent |
/// | Call ends while its session is visible again | no close — the learner is in it |
/// | Return to the call session, later leave it without a call | normal close on that later switch |
///
/// An app killed mid-call sends nothing at all; the server's own quiet sweep
/// closes the session whole, which is what that backstop is for.
struct DeferredSessionClose: Equatable {
    /// The session whose close is waiting on a call to end. `nil` the rest of
    /// the time, which is every ordinary switch.
    private(set) var pendingSessionID: UUID?

    init(pendingSessionID: UUID? = nil) {
        self.pendingSessionID = pendingSessionID
    }

    /// The learner has left `outgoing`.
    ///
    /// - Parameter callSessionID: The session a call is live in, or `nil` when
    ///   no call is running.
    /// - Returns: Whether the server may be told now.
    mutating func switchingAway(from outgoing: UUID, callSessionID: UUID?) -> Bool {
        guard callSessionID != outgoing else {
            pendingSessionID = outgoing
            return false
        }
        // Leaving a session whose deferred close never fired — the call in it
        // ended while the learner was looking at it, so there is nothing left
        // to wait for and this switch is the ordinary one.
        if pendingSessionID == outgoing { pendingSessionID = nil }
        return true
    }

    /// The call in `sessionID` has ended.
    ///
    /// - Returns: The session to close on the server now, or `nil` — either
    ///   because no close was deferred for it, or because the learner is
    ///   looking at that session again and has not left it.
    mutating func callEnded(inSession sessionID: UUID, visibleSessionID: UUID) -> UUID? {
        guard pendingSessionID == sessionID else { return nil }
        pendingSessionID = nil
        return sessionID == visibleSessionID ? nil : sessionID
    }

    /// The session was destroyed (deleted, or Settings' reset). A destroyed
    /// session is told to be forgotten, never to be closed, so the debt is
    /// simply dropped.
    mutating func forget(_ sessionID: UUID) {
        if pendingSessionID == sessionID { pendingSessionID = nil }
    }
}
