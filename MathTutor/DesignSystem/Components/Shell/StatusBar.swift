import SwiftUI

/// Draws the design's mock status band over this view.
///
/// **Release builds never draw one.** iPadOS owns the band on a real device: it knows the
/// time, the network and the battery, it re-lays itself out for every device and orientation,
/// and it is the thing the safe-area inset is measured from. The app-drawn band existed to
/// make a screenshot read as a device; on a device it is a second, wrong status bar sitting
/// under the real one.
///
/// It survives in DEBUG for one job: `design/reference/screen-0*.png` were exported with the
/// band drawn at `y = 16`, so a `--ui-fixture` run has to draw it too or every pixel below it
/// moves. The caller passes `isEnabled` from that launch flag — the decision is the app's, and
/// the component is only ever available to make it.
extension View {
    func fixtureStatusBar(isEnabled: Bool, width: CGFloat) -> some View {
        #if DEBUG
        // `topLeading`, not `top`: the band's own children are placed at absolute x inside a
        // full-screen-width box, exactly as the board draws them.
        return overlay(alignment: .topLeading) {
            if isEnabled {
                StatusBar(width: width).offset(y: StatusBarMetrics.top)
            }
        }
        #else
        return self
        #endif
    }
}

#if DEBUG
enum StatusBarMetrics {
    /// The design draws its band at `y = 16`, not at 0.
    static let top: CGFloat = 16
    static let height: CGFloat = 24
    /// `16 + 24`. Board 01 measures the whole screen from here: *"the status band ends at
    /// y 40, so content starts at 40 + 28 = 68."*
    ///
    /// Which makes this the **top safe-area inset the design assumed**, and it is 40 on no
    /// real iPad — landscape reports 24 with a camera housing and 20 with a home button. A
    /// `--ui-fixture` run therefore has to lay the screen out from *this* number rather than
    /// from the live inset, or the fixture screenshot and the reference PNG disagree by
    /// `40 − 24 = 16pt` on every element below the band.
    static var bandBottom: CGFloat { top + height }

    static let leftGroupX: CGFloat = 30
    static let leftGroupWidth: CGFloat = 134
    static let leftGroupGap: CGFloat = 12

    /// The right group is inset 24 from the screen's right edge — on the design's 1376 screen
    /// that reads `1251 + 101 = 1352`, which is where the board draws it.
    static let rightGroupInset: CGFloat = 24
    static let rightGroupWidth: CGFloat = 101
    static let rightGroupGap = DS.Space.s2

    /// `os/wifi` and `os/battery` slots, kept as reserved space — see `StatusBar`.
    static let wifiSlot = CGSize(width: 22, height: 20)
    static let batterySlot = CGSize(width: 27, height: 14)

    /// Where the right group starts, given the width the band is drawn at. The design's
    /// `1251` is this at 1376 and nowhere else, which is why it is derived rather than typed.
    static func rightGroupX(for width: CGFloat) -> CGFloat {
        max(0, width - rightGroupInset - rightGroupWidth)
    }
}

/// The design's mock iPadOS status bar. **Not shipped — see `fixtureStatusBar`.**
///
/// **The two OS glyphs are deliberately absent.** Board 04 heads them "06 · OS CHROME — DO
/// NOT SHIP": *"They are stand-ins for the iPadOS status bar, drawn only so the screens read
/// as a real device, and iPadOS supplies the real ones at runtime. Do not port them, do not
/// add them to an asset catalogue, and do not treat their geometry as a house rule."* Their
/// slots are still reserved at the design's sizes, so the right group keeps its 101pt width
/// and a specimen still lines up against the board.
///
/// Board 05 open question 15 asked which branch the product takes: hide the system bar and
/// draw this one, or drop it and re-anchor the content top to the safe area. **The product
/// takes the second branch** — this one is now the fixture-only path, kept so the pixel diff
/// against the boards still has the geometry the boards were drawn with.
struct StatusBar: View {
    private let width: CGFloat
    private let time: String
    private let date: String
    private let batteryPercentage: String

    /// The defaults are the design's own literal copy, which is what a specimen and a
    /// reference screenshot both want; nothing shipped reads them.
    init(
        width: CGFloat,
        time: String = "9:41 AM",
        date: String = "Tue May 21",
        batteryPercentage: String = "100%"
    ) {
        self.width = max(0, width)
        self.time = time
        self.date = date
        self.batteryPercentage = batteryPercentage
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.clear
            leftGroup.offset(x: StatusBarMetrics.leftGroupX)
            rightGroup.offset(x: StatusBarMetrics.rightGroupX(for: width))
        }
        .frame(width: width, height: StatusBarMetrics.height)
    }

    private var leftGroup: some View {
        HStack(spacing: StatusBarMetrics.leftGroupGap) {
            label(time)
            label(date)
        }
        .frame(width: StatusBarMetrics.leftGroupWidth, alignment: .leading)
    }

    private var rightGroup: some View {
        HStack(spacing: StatusBarMetrics.rightGroupGap) {
            reservedSlot(StatusBarMetrics.wifiSlot)
            label(batteryPercentage)
            reservedSlot(StatusBarMetrics.batterySlot)
        }
        .frame(width: StatusBarMetrics.rightGroupWidth, alignment: .trailing)
    }

    private func label(_ text: String) -> some View {
        Text(text)
            .textStyle(.statusBar)
            .foregroundStyle(DS.Color.ink)
    }

    private func reservedSlot(_ size: CGSize) -> some View {
        Color.clear
            .frame(width: size.width, height: size.height)
            .accessibilityHidden(true)
    }
}

#Preview("Status bar") {
    StatusBar(width: DS.Container.screen)
        .padding(.top, StatusBarMetrics.top)
        .frame(width: DS.Container.screen, alignment: .topLeading)
        .background(DS.Color.surfaceScreen)
}
#endif
