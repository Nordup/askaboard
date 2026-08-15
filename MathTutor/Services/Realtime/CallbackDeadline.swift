import Foundation

/// Thrown when a callback-style operation did not call back inside its deadline.
///
/// `label` names the stage that hung, so the failure that reaches the log says *where* the
/// connection stopped rather than only that it stopped. Ported from the sleep app's
/// `SleepOffloadKit.CallbackDeadline`, which exists because a WebRTC bring-up can apply an SDP
/// answer and then never report ICE, DTLS or a data channel again — an unbounded
/// `withCheckedContinuation` bridge then waits forever with nothing surfaced.
struct CallbackDeadlineExceeded: Error, Equatable, Sendable {
    let label: String
    let seconds: Double
}

/// Bridges a callback-style API into `async`/`await` **with a hard deadline**.
///
/// Races the callback against a timer on `queue`: whichever fires first wins, the loser is
/// discarded, and the continuation is resumed exactly once. Deliberately **not** a
/// `withThrowingTaskGroup` race — a child task blocked in a continuation that ignores
/// cancellation never finishes, and the group waits for all of its children, so the "timeout"
/// would hang on exactly the failure it exists to bound.
enum CallbackDeadline {

    /// - Parameters:
    ///   - label: Stage name carried into the error, e.g. `"ice/dtls"`.
    ///   - seconds: Deadline. Zero or negative fails immediately without running `body`.
    ///   - queue: Queue the timer fires on. `body`'s completion may be called from any thread.
    ///   - timeoutError: Builds the thrown error; defaults to `CallbackDeadlineExceeded`.
    ///   - body: Starts the work and calls its completion exactly once — or never, which is the
    ///     case this exists for. Extra calls after the first are ignored, not a crash.
    static func run<T>(
        label: String,
        seconds: Double,
        queue: DispatchQueue,
        timeoutError: @escaping @Sendable (String, Double) -> Error = { CallbackDeadlineExceeded(label: $0, seconds: $1) },
        body: (@escaping @Sendable (Result<T, Error>) -> Void) -> Void
    ) async throws -> T where T: Sendable {
        guard seconds > 0 else { throw timeoutError(label, max(0, seconds)) }

        let gate = ResumeGate()
        return try await withCheckedThrowingContinuation { continuation in
            queue.asyncAfter(deadline: .now() + seconds) {
                guard gate.claim() else { return }
                continuation.resume(throwing: timeoutError(label, seconds))
            }
            body { result in
                guard gate.claim() else { return }
                continuation.resume(with: result)
            }
        }
    }
}

/// One-shot claim. The first caller wins; every later caller is told to do nothing, which is what
/// keeps a late callback from resuming an already-resumed continuation (a crash, not a warning).
private final class ResumeGate: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false

    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if claimed { return false }
        claimed = true
        return true
    }
}
