#if DEBUG
import Foundation
import PencilKit

/// **Temporary.** Which of the things this app does to `PKCanvasView` are switched
/// on, so the stroke-tail artifact can be attributed to one of them by relaunching
/// rather than rebuilding. Delete with the probe once the cause is known.
///
/// `--board-config <mode>`; the default is exactly what ships.
enum BoardConfig: String {
    /// Everything the product does. The shipping configuration.
    case full
    /// Everything except the scrolling geometry: the content is the viewport, the
    /// zoom range is 1–1, nothing bounces. This is the biggest single difference
    /// between this board and the canvas in Notes or Procreate — ink at coordinate
    /// ~25,000 on a 50,000pt canvas, with a 0.25–3 zoom range over it.
    case plainScroll = "plain-scroll"
    /// Everything except the two- and three-finger tap recognizers.
    case noTaps = "no-taps"
    /// As near a stock `PKCanvasView` as this app can produce.
    case vanilla

    static let current: BoardConfig = {
        let arguments = ProcessInfo.processInfo.arguments
        guard let flag = arguments.firstIndex(of: "--board-config"),
              arguments.indices.contains(flag + 1),
              let mode = BoardConfig(rawValue: arguments[flag + 1])
        else { return .full }
        return mode
    }()

    var usesBoardGeometry: Bool { self == .full || self == .noTaps }
    var addsMultiTouchTaps: Bool { self == .full || self == .plainScroll }
}

/// Times PencilKit's own lift-to-commit against what this app then spends.
enum InkTrace {
    private nonisolated(unsafe) static var liftedAt: CFAbsoluteTime?
    private nonisolated(unsafe) static var commitBeganAt: CFAbsoluteTime = 0
    private nonisolated(unsafe) static var samples: [String] = []

    static func penLifted() { liftedAt = CFAbsoluteTimeGetCurrent() }

    static func commitBegan(strokes: Int) {
        commitBeganAt = CFAbsoluteTimeGetCurrent()
        let lift = liftedAt.map { (commitBeganAt - $0) * 1000 } ?? -1
        samples.append(String(format: "%.1f", lift))
        liftedAt = nil
    }

    static func commitEnded() {
        guard samples.count >= 8 else { return }
        let values = samples.compactMap(Double.init).filter { $0 >= 0 }
        let batch = samples.joined(separator: ",")
        samples.removeAll(keepingCapacity: true)
        let mean = values.isEmpty ? 0 : values.reduce(0, +) / Double(values.count)
        NSLog(
            "INKTRACE mode=%@ liftToCommit_ms=[%@] mean=%.1f max=%.1f",
            BoardConfig.current.rawValue, batch, mean, values.max() ?? 0
        )
    }
}
#endif
