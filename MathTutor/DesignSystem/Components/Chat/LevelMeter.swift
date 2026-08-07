import SwiftUI

/// `ui/level` — five bars that move because the microphone is hearing something.
///
/// Board 15. It is the one indicator in the product whose motion is *caused by* the thing it
/// reports, and that is the whole point of it: `state/thinking`'s dots run on a 1.2s loop
/// whether or not the mic is working, so during capture — when no words are arriving to prove
/// anything — they would be a signal of nothing, identical for an open microphone, a muted one,
/// a Smart Folio closed over the mic array, and a student sitting too far away.
///
/// It also discharges an obligation the app cannot meet with the OS's orange dot: App Store
/// guideline 2.5.14 requires *the app* to *"provide a clear visual and/or audible indication
/// when recording"*.
///
/// **No new colour, fill, radius or elevation.** A bar is `state/thinking`'s own 6pt dot at
/// `--radius-full` in `--color-icon`, stretched — which is why silence draws exactly five dots
/// and reads as the mark the system already uses for "something is happening, nothing to show".
struct LevelMeterMetrics: Equatable, Sendable {
    /// Panel: `state/thinking`'s dot, already documented as component-internal.
    /// Full screen: `--spacing-2`.
    let barWidth: CGFloat
    /// `--spacing-2` · `--spacing-3`.
    let gap: CGFloat
    /// **= the bar width**, so silence renders a circle rather than a sliver.
    let minimumHeight: CGFloat
    /// `--leading-body` · `--leading-lead` — the line box the text lane already occupies, so
    /// the meter can never make the composer taller.
    let maximumHeight: CGFloat

    /// Five. The one number on this component with no derivation behind it: three reads as the
    /// thinking dots, and seven does not fit the panel's 133pt lane. Component-internal, in the
    /// same manner as `state/thinking`'s 6pt dot.
    static let barCount = 5

    /// ~20 Hz. Fast enough that a syllable moves a bar, slow enough that the composer is not
    /// re-rendering on every display frame.
    static let sampleInterval: TimeInterval = 0.05

    static let panel = Self(barWidth: 6, gap: DS.Space.s2, minimumHeight: 6, maximumHeight: DS.Leading.body)
    static let fullScreen = Self(barWidth: DS.Space.s2, gap: DS.Space.s3, minimumHeight: DS.Space.s2, maximumHeight: DS.Leading.lead)

    /// `5 × 6 + 4 × 8 = 62` at panel scale; `5 × 8 + 4 × 12 = 88` full screen.
    var width: CGFloat {
        CGFloat(Self.barCount) * barWidth + CGFloat(Self.barCount - 1) * gap
    }

    /// The bar heights for one level, tallest in the middle.
    ///
    /// A level meter with five identical bars would be a bar chart of one number drawn five
    /// times. The centre weighting is what makes it read as a voice rather than a gauge, and it
    /// costs no new value: the weights are a fixed shape applied to the one measured number.
    func heights(for level: Double) -> [CGFloat] {
        let clamped = min(1, max(0, level))
        return Self.weights.map { weight in
            minimumHeight + (maximumHeight - minimumHeight) * CGFloat(clamped * weight)
        }
    }

    /// **The one value here the board does not state.** Board 15 specifies the bar count, the
    /// widths, the gaps and the two heights; a five-bar meter still needs a shape for how one
    /// measured level becomes five bars, and this is it — symmetric, tallest in the middle. Any
    /// weighting is an invention, and a flat one (all five bars identical) would be the same
    /// number drawn five times, which reads as a gauge rather than as a voice.
    private static let weights: [Double] = [0.45, 0.75, 1.0, 0.75, 0.45]
}

struct LevelMeter: View {
    var metrics: LevelMeterMetrics = .panel
    /// Sampled here rather than pushed in, so twenty readings a second do not become twenty
    /// state changes a second in the composer above it.
    let level: () -> Double

    var body: some View {
        TimelineView(.periodic(from: .now, by: LevelMeterMetrics.sampleInterval)) { _ in
            bars(for: level())
        }
        .frame(width: metrics.width, height: metrics.maximumHeight)
        // The meter is the visual half of a pair; the spoken half is the mic button's own
        // accessibility value, which says "Recording" without needing this.
        .accessibilityHidden(true)
    }

    private func bars(for level: Double) -> some View {
        HStack(spacing: metrics.gap) {
            ForEach(Array(metrics.heights(for: level).enumerated()), id: \.offset) { _, height in
                Capsule()
                    .fill(DS.Color.icon)
                    .frame(width: metrics.barWidth, height: height)
            }
        }
        .frame(height: metrics.maximumHeight)
    }
}

/// How long the microphone has been open, beside the meter.
///
/// The cap at `BackendDictationService.captureLimit` is not a surprise if it is visible: this is
/// the warning, and because reaching it transcribes what was said rather than discarding it,
/// nothing is lost at the boundary.
struct ElapsedLabel: View {
    let start: Date
    var style: DS.TextStyle = TextStyle(size: DS.Size.label, leading: DS.Leading.label, weight: .regular)

    var body: some View {
        TimelineView(.periodic(from: start, by: 1)) { context in
            Text(verbatim: Self.text(for: context.date.timeIntervalSince(start)))
                .textStyle(style)
                .foregroundStyle(DS.Color.inkSecondary)
                .monospacedDigit()
        }
        .accessibilityHidden(true)
    }

    /// `0:07`. Seconds never reach three digits — the session ends at one minute.
    static func text(for elapsed: TimeInterval) -> String {
        let seconds = max(0, Int(elapsed))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}
