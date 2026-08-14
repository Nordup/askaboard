import ExtendedSwiftMath
import SwiftUI
import UIKit
import XCTest
@testable import MathTutor

/// The inverted thread's two contracts, which used to pull in opposite directions.
///
/// Laziness: rows used to be a plain `VStack`, so every message's formula-backed
/// `MTMathUILabel`s stayed live for the whole conversation and were re-measured
/// on layout passes. The thread is a `LazyVStack` now, which keeps the live
/// count bounded however long the session gets.
///
/// The white mount: a lazy, oldest-first thread under `defaultScrollAnchor(.bottom)`
/// sometimes mounted with the anchored window on rows that were never realized,
/// and the panel showed nothing until a drag. The thread is inverted now
/// (`ChatScrollColumn.Anchor.newestFirst`): the newest message is the layout-first
/// row, the rest position is offset zero, and the rows a lazy stack builds first
/// are exactly the rows that position shows — the two contracts stopped competing.
///
/// The flip is applied outside the `UIScrollView`, so everything these tests read —
/// offsets, content size, converted frames — is plain, unflipped layout space.
final class MessageThreadLazinessTests: XCTestCase {

    private let rowCount = 60
    private let formulasPerRow = 3

    /// The ceiling on live math labels: the realized window near the rest position
    /// plus the lazy stack's realization slack — half the history, comfortably.
    private var liveBound: Int { rowCount * formulasPerRow / 2 }

    /// The white-mount regression itself: on a fresh mount, the rest position must
    /// show realized rows. Inverted, the rest position is offset zero and the lazy
    /// stack realizes from layout top, so this cannot come up empty — which is the
    /// architectural claim this test pins.
    @MainActor
    func testRestPositionShowsRealizedRowsOnAFreshMount() throws {
        let host = try mountedThread()
        let scrollView = try scroller(in: host.view)

        let restWindow = CGRect(origin: scrollView.contentOffset, size: scrollView.bounds.size)
        let labelsInWindow = mathLabels(in: host.view).filter { label in
            label.convert(label.bounds, to: scrollView).intersects(restWindow)
        }
        XCTAssertFalse(
            labelsInWindow.isEmpty,
            "A freshly mounted thread must rest on realized rows, not a blank window"
        )
    }

    /// The newest message is the first row in layout — offset zero is the tail of
    /// the conversation, not its head.
    @MainActor
    func testNewestMessageIsAtTheLayoutTop() throws {
        let host = try mountedThread(markNewest: true)
        let scrollView = try scroller(in: host.view)

        // The newest row carries a formula none of the history rows have; its label
        // must sit nearer the layout top than every history label does.
        let labels = mathLabels(in: host.view)
        let byTop = labels.sorted { lhs, rhs in
            lhs.convert(lhs.bounds, to: scrollView).minY < rhs.convert(rhs.bounds, to: scrollView).minY
        }
        let firstRowLabels = byTop.prefix(formulasPerRow)
        XCTAssertTrue(
            firstRowLabels.contains { $0.latex.contains("\\Omega") },
            "The newest message's math must be the layout-first row of the inverted thread"
        )
    }

    @MainActor
    func testThreadKeepsTheLiveMathCountBounded() throws {
        let host = try mountedThread()
        let scrollView = try scroller(in: host.view)

        let totalFormulas = rowCount * formulasPerRow
        let initiallyLive = mathLabels(in: host.view).count
        XCTAssertGreaterThan(initiallyLive, 0, "Rows at the rest position still render their math")
        XCTAssertLessThanOrEqual(
            initiallyLive,
            liveBound,
            "A \(rowCount)-row thread must not materialize \(totalFormulas) formulas up front; "
                + "only rows near the rest position should be realized (got \(initiallyLive))"
        )

        // Travel to the head of the conversation — the layout bottom, since the
        // thread is inverted. Rows realize in a window as they arrive and release as
        // they leave, so the live count stays bounded however long the history gets.
        scrollView.setContentOffset(
            CGPoint(
                x: 0,
                y: max(0, scrollView.contentSize.height - scrollView.bounds.height)
            ),
            animated: false
        )
        scrollView.layoutIfNeeded()
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.1))
        host.view.layoutIfNeeded()

        let liveAfterScrolling = mathLabels(in: host.view).count
        XCTAssertGreaterThan(liveAfterScrolling, 0, "Scrolled-to rows still render their math")
        XCTAssertLessThanOrEqual(
            liveAfterScrolling,
            liveBound,
            "Scrolling through the history must release offscreen rows instead of retaining "
                + "\(totalFormulas) formulas (got \(liveAfterScrolling))"
        )
    }

    // MARK: - Fixture

    /// A thread of identical math rows; `markNewest` gives the last (newest) message
    /// a formula the history never uses, so a test can find its row geometrically.
    @MainActor
    private func mountedThread(markNewest: Bool = false) throws -> UIHostingController<some View> {
        var items = (0..<rowCount).map { _ in
            ChatThreadItem(
                TutorMessage(
                    role: .tutor,
                    text: "The constant \\(k_B\\) and temperature \\(T\\) give \\(\\frac{3}{2}k_BT\\)."
                )
            )
        }
        if markNewest {
            items[items.count - 1] = ChatThreadItem(
                TutorMessage(
                    role: .tutor,
                    text: "So the resistance is \\(\\Omega\\), the current \\(I\\), the voltage \\(V\\)."
                )
            )
        }

        let host = UIHostingController(
            rootView: MessageThread(items: items, scale: .panel)
                .frame(width: 360, height: 480)
        )
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 360, height: 480))
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.frame = CGRect(origin: .zero, size: CGSize(width: 360, height: 480))
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.1))
        host.view.layoutIfNeeded()
        return host
    }

    @MainActor
    private func scroller(in root: UIView) throws -> UIScrollView {
        try XCTUnwrap(
            descendants(of: root).compactMap { $0 as? UIScrollView }.first,
            "Expected the thread's scroll view"
        )
    }

    @MainActor
    private func mathLabels(in root: UIView) -> [MTMathUILabel] {
        descendants(of: root).compactMap { $0 as? MTMathUILabel }
    }

    @MainActor
    private func descendants(of view: UIView) -> [UIView] {
        view.subviews.flatMap { [$0] + descendants(of: $0) }
    }
}
