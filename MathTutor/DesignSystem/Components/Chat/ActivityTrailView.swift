import SwiftUI
import UIKit

/// Keeps the tapped disclosure control at one absolute screen coordinate while
/// its reveal changes the inverted thread's content height. The reveal reports
/// its exact interpolated height before each layout pass, and the scroll view
/// receives the matching offset in that same pass.
@MainActor
private final class ActivityDisclosureScrollAnchor: ObservableObject {
    weak var marker: UIView?
    weak var scrollView: UIScrollView?
    @Published private(set) var completedMaxDrift: CGFloat = 0
    @Published private(set) var completedDriftRange: ClosedRange<CGFloat> = 0...0

    private var desiredWindowY: CGFloat?
    private var maxObservedDrift: CGFloat = 0
    private var minObservedDrift: CGFloat = 0
    private var maxSignedObservedDrift: CGFloat = 0
    private var displayLink: CADisplayLink?
    private var activeRevealID: String?
    private var initialRevealHeight: CGFloat = 0
    private var finalRevealHeight: CGFloat = 0
    private var initialContentOffsetY: CGFloat = 0

    func attach(_ marker: UIView) {
        self.marker = marker
    }

    /// Receives the exact interpolated height that SwiftUI is about to draw.
    /// Driving the scroll offset from the same value keeps both animations in
    /// lockstep instead of measuring and correcting one rendered frame later.
    func revealHeightDidUpdate(id: String, height: CGFloat) {
        guard id == activeRevealID, let scrollView, !scrollView.isDragging else { return }
        let target = initialContentOffsetY + height - initialRevealHeight
        setOffset(target, in: scrollView)
    }

    func animate(
        anchorID: String,
        revealID: String,
        from initialHeight: CGFloat,
        to finalHeight: CGFloat,
        change: () -> Void,
        completion: @escaping () -> Void = {}
    ) {
        let activeMarker = ActivityLayoutFrameRegistry.shared.marker(for: anchorID) ?? marker
        guard let activeMarker,
              activeMarker.window != nil,
              let scrollView = activeMarker.enclosingScrollView
        else {
            withAnimation(Self.animation) { change() } completion: {
                completion()
            }
            return
        }

        activeRevealID = revealID
        initialRevealHeight = initialHeight
        finalRevealHeight = finalHeight
        initialContentOffsetY = scrollView.contentOffset.y
        startMonitoring(
            activeMarker,
            in: scrollView,
            heightDelta: finalHeight - initialHeight
        )
        withAnimation(Self.animation) {
            change()
        } completion: {
            self.finishMonitoring()
            completion()
        }
    }

    private func startMonitoring(
        _ marker: UIView,
        in scrollView: UIScrollView,
        heightDelta: CGFloat
    ) {
        displayLink?.invalidate()
        self.marker = marker
        self.scrollView = scrollView
        desiredWindowY = marker.windowMidY
        maxObservedDrift = 0
        minObservedDrift = 0
        maxSignedObservedDrift = 0
        completedMaxDrift = 0
        completedDriftRange = 0...0
        if Self.logsEnabled {
            ActivityLayoutFrameRegistry.shared.begin(anchor: marker, expectedDelta: heightDelta)
        }
        let link = CADisplayLink(target: self, selector: #selector(samplePosition))
        link.add(to: .main, forMode: .common)
        displayLink = link
        if Self.logsEnabled {
            print("[ActivityAnchor] start y=\(marker.windowMidY)")
        }
    }

    @objc private func samplePosition() {
        guard let marker, let scrollView, let desiredWindowY else { return }
        let before = marker.presentationWindowMidY
        let current = marker.presentationWindowMidY
        let correctedDrift = current - desiredWindowY
        maxObservedDrift = max(maxObservedDrift, abs(correctedDrift))
        minObservedDrift = min(minObservedDrift, correctedDrift)
        maxSignedObservedDrift = max(maxSignedObservedDrift, correctedDrift)
        ActivityLayoutFrameRegistry.shared.sample()
        if Self.logsEnabled {
            print(
                "[ActivityAnchor] frame before=\(before) y=\(current) " +
                "drift=\(correctedDrift) offset=\(scrollView.contentOffset.y) " +
                "content=\(scrollView.contentSize.height) viewport=\(scrollView.bounds.height)"
            )
        }
    }

    private func setOffset(_ target: CGFloat, in scrollView: UIScrollView) {
        let minimum = -scrollView.adjustedContentInset.top
        let maximum = max(
            minimum,
            scrollView.contentSize.height
                - scrollView.bounds.height
                + scrollView.adjustedContentInset.bottom
        )
        var offset = scrollView.contentOffset
        offset.y = min(max(target, minimum), maximum)
        UIView.performWithoutAnimation {
            scrollView.setContentOffset(offset, animated: false)
        }
    }

    private func finishMonitoring() {
        if let scrollView {
            setOffset(
                initialContentOffsetY + finalRevealHeight - initialRevealHeight,
                in: scrollView
            )
            scrollView.layoutIfNeeded()
        }
        samplePosition()
        displayLink?.invalidate()
        displayLink = nil
        completedMaxDrift = maxObservedDrift
        completedDriftRange = minObservedDrift...maxSignedObservedDrift
        ActivityLayoutFrameRegistry.shared.finish()
        if Self.logsEnabled {
            print("[ActivityAnchor] end maxDrift=\(maxObservedDrift)")
        }
        desiredWindowY = nil
        scrollView = nil
        activeRevealID = nil
    }

    // The 2018 iPad needs enough time to lay out five source rows without a
    // perceptible catch-up step. Keep the same calm ease-in-out motion as the
    // rest of the thread.
    private static let duration: TimeInterval = 0.30
    private static let animation = Animation.easeInOut(duration: duration)
    private static var logsEnabled: Bool {
        ProcessInfo.processInfo.arguments.contains("--ui-activity-anchor-logs")
    }
}

private extension UIView {
    var enclosingScrollView: UIScrollView? {
        var ancestor = superview
        while let current = ancestor {
            if let scrollView = current as? UIScrollView { return scrollView }
            ancestor = current.superview
        }
        return nil
    }

    var windowMidY: CGFloat {
        guard let window else { return 0 }
        return convert(bounds, to: window).midY
    }

    var presentationWindowMidY: CGFloat {
        guard let window else { return 0 }
        let source = layer.presentation() ?? layer
        let destination = window.layer.presentation() ?? window.layer
        return source.convert(bounds, to: destination).midY
    }

    var presentationWindowFrame: CGRect {
        guard let window else { return .null }
        let source = layer.presentation() ?? layer
        let destination = window.layer.presentation() ?? window.layer
        return source.convert(bounds, to: destination)
    }

    var presentationVisibleWindowFrame: CGRect? {
        guard let window else { return nil }
        var visible = presentationWindowFrame.intersection(window.bounds)
        var ancestor = superview
        while let current = ancestor, !visible.isNull, !visible.isEmpty {
            if current.clipsToBounds {
                let source = current.layer.presentation() ?? current.layer
                let destination = window.layer.presentation() ?? window.layer
                visible = visible.intersection(source.convert(current.bounds, to: destination))
            }
            ancestor = current.superview
        }
        return visible.isNull || visible.isEmpty ? nil : visible
    }
}

/// Debug-only registry used by the unfrozen UI test. It measures presentation
/// frames, not SwiftUI's settled model frames, so one bad rendered frame fails
/// the same invariant the learner sees on screen.
@MainActor
final class ActivityLayoutFrameRegistry {
    static let shared = ActivityLayoutFrameRegistry()

    private final class WeakMarker {
        weak var view: UIView?
        init(_ view: UIView) { self.view = view }
    }

    private var markers: [String: WeakMarker] = [:]
    private var baseline: [String: CGRect] = [:]
    private var stationaryIDs: Set<String> = []
    private var movingIDs: Set<String> = []
    private var previousMovingDisplacement: [String: CGFloat] = [:]
    private var expectedDelta: CGFloat = 0
    private var frameIndex = 0

    private(set) var completedStationaryDrift: CGFloat = 0
    private(set) var completedMovingSpread: CGFloat = 0
    private(set) var completedDirectionReversals = 0
    private(set) var completedMaxFrameStep: CGFloat = 0
    private(set) var completedSampleCount = 0
    private(set) var completedWorstStationaryID = "none"

    private var stationaryDrift: CGFloat = 0
    private var movingSpread: CGFloat = 0
    private var directionReversals = 0
    private var maxFrameStep: CGFloat = 0
    private var worstStationaryID = "none"

    private var isEnabled: Bool {
        ProcessInfo.processInfo.arguments.contains("--ui-activity-anchor-logs")
    }

    func register(_ view: UIView, id: String) {
        guard isEnabled else { return }
        markers[id] = WeakMarker(view)
    }

    func marker(for id: String) -> UIView? {
        markers[id]?.view
    }

    func begin(anchor: UIView, expectedDelta: CGFloat) {
        guard isEnabled, anchor.window != nil else { return }
        markers = markers.filter { $0.value.view != nil }
        baseline = markers.compactMapValues { marker in
            guard let view = marker.view else { return nil }
            let frame = view.presentationWindowFrame
            return view.presentationVisibleWindowFrame == nil ? nil : frame
        }

        let anchorFrame = anchor.presentationWindowFrame
        stationaryIDs = Set(baseline.compactMap { id, frame in
            frame.maxY <= anchorFrame.minY + 0.5 ? id : nil
        })
        // During collapse, the disappearing detail rows occupy the band
        // immediately below the clicked control. They are the reveal itself,
        // not the lower sibling group whose coherent translation we assert.
        let movingThreshold = anchorFrame.maxY + (expectedDelta < 0 ? abs(expectedDelta) : 0) - 0.5
        movingIDs = Set(baseline.compactMap { id, frame in
            frame.minY >= movingThreshold ? id : nil
        })
        self.expectedDelta = expectedDelta
        previousMovingDisplacement = movingIDs.reduce(into: [:]) { $0[$1] = 0 }
        frameIndex = 0
        stationaryDrift = 0
        movingSpread = 0
        directionReversals = 0
        maxFrameStep = 0
        completedStationaryDrift = 0
        completedMovingSpread = 0
        completedDirectionReversals = 0
        completedMaxFrameStep = 0
        completedSampleCount = 0
        completedWorstStationaryID = "none"
        worstStationaryID = "none"
        sample()
    }

    func sample() {
        guard isEnabled, !baseline.isEmpty else { return }
        frameIndex += 1
        var movingDisplacements: [CGFloat] = []

        for id in markers.keys.sorted() {
            guard let view = markers[id]?.view else { continue }
            let frame = view.presentationWindowFrame
            guard !frame.isNull else { continue }
            guard let baselineFrame = baseline[id] else { continue }
            let displacement = frame.midY - baselineFrame.midY

            if stationaryIDs.contains(id) {
                if abs(displacement) > stationaryDrift {
                    stationaryDrift = abs(displacement)
                    worstStationaryID = id
                }
            }
            if movingIDs.contains(id) {
                movingDisplacements.append(displacement)
                let previous = previousMovingDisplacement[id] ?? 0
                let step = displacement - previous
                maxFrameStep = max(maxFrameStep, abs(step))
                if expectedDelta > 0, step < -0.5 { directionReversals += 1 }
                if expectedDelta < 0, step > 0.5 { directionReversals += 1 }
                previousMovingDisplacement[id] = displacement
            }
        }

        if let minimum = movingDisplacements.min(), let maximum = movingDisplacements.max() {
            movingSpread = max(movingSpread, maximum - minimum)
        }
    }

    func finish() {
        guard isEnabled else { return }
        sample()
        completedStationaryDrift = stationaryDrift
        completedMovingSpread = movingSpread
        completedDirectionReversals = directionReversals
        completedMaxFrameStep = maxFrameStep
        completedSampleCount = frameIndex
        completedWorstStationaryID = worstStationaryID
        print(
            "[ActivityFrames] end samples=\(frameIndex) stationaryDrift=\(stationaryDrift) " +
            "movingSpread=\(movingSpread) reversals=\(directionReversals) maxStep=\(maxFrameStep) " +
            "worstStationary=\(worstStationaryID)"
        )
        baseline = [:]
        stationaryIDs = []
        movingIDs = []
    }

}

struct ActivityLayoutFrameMarker: UIViewRepresentable {
    let id: String

    func makeUIView(context: Context) -> MarkerView {
        MarkerView(id: id)
    }

    func updateUIView(_ marker: MarkerView, context: Context) {
        marker.id = id
        ActivityLayoutFrameRegistry.shared.register(marker, id: id)
    }

    final class MarkerView: UIView {
        var id: String

        init(id: String) {
            self.id = id
            super.init(frame: .zero)
            isUserInteractionEnabled = false
            backgroundColor = .clear
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { nil }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            ActivityLayoutFrameRegistry.shared.register(self, id: id)
        }

    }
}

private struct ActivityDisclosureAnchorMarker: UIViewRepresentable {
    let anchor: ActivityDisclosureScrollAnchor

    func makeUIView(context: Context) -> MarkerView {
        MarkerView(anchor: anchor)
    }

    func updateUIView(_ marker: MarkerView, context: Context) {
        marker.anchor = anchor
        anchor.attach(marker)
    }

    final class MarkerView: UIView {
        weak var anchor: ActivityDisclosureScrollAnchor?

        init(anchor: ActivityDisclosureScrollAnchor) {
            self.anchor = anchor
            super.init(frame: .zero)
            isUserInteractionEnabled = false
            backgroundColor = .clear
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { nil }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if let anchor { anchor.attach(self) }
        }

    }
}

/// `frame(height:)` participates in layout animation on current SwiftUI, but
/// iPadOS 17 applies its new value in one layout pass and only animates the
/// surrounding transaction. Making the height explicit animatable data forces
/// the layout container itself through every intermediate height on that OS.
private struct ActivityRevealHeightModifier: AnimatableModifier {
    let id: String
    let onHeightUpdate: (String, CGFloat) -> Void
    var height: CGFloat

    init(
        height: CGFloat,
        id: String,
        onHeightUpdate: @escaping (String, CGFloat) -> Void
    ) {
        self.height = height
        self.id = id
        self.onHeightUpdate = onHeightUpdate
    }

    nonisolated var animatableData: CGFloat {
        get { height }
        set { height = newValue }
    }

    func body(content: Content) -> some View {
        content
            .frame(height: max(0, height), alignment: .top)
            .clipped()
            .background {
                ActivityRevealHeightReporter(
                    id: id,
                    height: max(0, height),
                    onHeightUpdate: onHeightUpdate
                )
            }
    }
}

private struct ActivityRevealHeightReporter: UIViewRepresentable {
    let id: String
    let height: CGFloat
    let onHeightUpdate: (String, CGFloat) -> Void

    func makeUIView(context: Context) -> UIView {
        let view = UIView(frame: .zero)
        view.isUserInteractionEnabled = false
        view.backgroundColor = .clear
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        onHeightUpdate(id, height)
    }
}

/// The rows inside a search reveal do not depend on the animated viewport
/// height. Keeping them in an equatable subtree prevents five links, glyphs,
/// and text stacks from being rebuilt during every interpolation step.
private struct TrailSourceList: View, Equatable {
    let sources: [TutorSource]
    let isAccessibilityHidden: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(sources) { source in
                TrailSourceRow(
                    source: source,
                    isAccessibilityHidden: isAccessibilityHidden
                )
            }
        }
    }
}

/// Disclosure behavior for a live or completed activity trail. Kept separate
/// from the view so streaming transitions are deterministic and testable.
struct TrailDisclosureState: Equatable {
    var isTrailExpanded: Bool
    var expandedItemID: String?

    init(trail: ActivityTrail) {
        isTrailExpanded = trail.duration == nil
        expandedItemID = trail.duration == nil && trail.items.last?.isExpandable == true
            ? trail.items.last?.id
            : nil
    }

    mutating func update(from oldTrail: ActivityTrail, to newTrail: ActivityTrail) {
        guard newTrail.duration == nil else {
            isTrailExpanded = false
            expandedItemID = nil
            return
        }

        isTrailExpanded = true
        let oldIDs = oldTrail.items.map(\.id)
        let newIDs = newTrail.items.map(\.id)
        if oldIDs != newIDs, let newest = newTrail.items.last {
            expandedItemID = newest.isExpandable ? newest.id : nil
            return
        }

        // Search results replace the matching generic tool row without
        // changing its id. This is the arrival of the live operation detail;
        // ordinary source updates still respect a manual collapse.
        if let oldLast = oldTrail.items.last,
           let newLast = newTrail.items.last,
           oldLast.id == newLast.id,
           !oldLast.isExpandable,
           newLast.isExpandable {
            expandedItemID = newLast.id
        }
    }

    mutating func toggleTrail() {
        isTrailExpanded.toggle()
        if !isTrailExpanded { expandedItemID = nil }
    }

    mutating func toggleItem(_ id: String) {
        expandedItemID = expandedItemID == id ? nil : id
    }
}

extension TrailItem {
    var isExpandable: Bool {
        switch self {
        case let .step(step): step.imageID != nil
        case let .search(search): !search.sources.isEmpty
        case .reasoning: false
        }
    }
}

/// One chronological, flat account of the work behind a tutor response.
/// Live work stays open. Completion folds it into a single `Worked for …`
/// row; reopening reveals independently expandable search and tool details.
struct ActivityTrailView: View {
    let trail: ActivityTrail
    let width: CGFloat
    let crop: (UUID) -> Data?
    let diagnosticNamespace: String

    @StateObject private var scrollAnchor = ActivityDisclosureScrollAnchor()
    @State private var disclosure: TrailDisclosureState
    @State private var accessibilityExpandedItemID: String?
    /// A fixed viewport exists only while the whole completed trail opens or
    /// closes. Once open it becomes `nil`, so a nested disclosure has exactly
    /// one animated height instead of also driving an enclosing height clock.
    @State private var outerRevealHeight: CGFloat?
    @State private var isTrailContentMounted: Bool
    @State private var isDisclosureAnimating = false

    init(
        trail: ActivityTrail,
        width: CGFloat,
        crop: @escaping (UUID) -> Data?,
        diagnosticNamespace: String = "activity"
    ) {
        self.trail = trail
        self.width = width
        self.crop = crop
        self.diagnosticNamespace = diagnosticNamespace
        _disclosure = State(initialValue: TrailDisclosureState(trail: trail))
        let initialDisclosure = TrailDisclosureState(trail: trail)
        _accessibilityExpandedItemID = State(initialValue: initialDisclosure.expandedItemID)
        _outerRevealHeight = State(initialValue: initialDisclosure.isTrailExpanded ? nil : 0)
        _isTrailContentMounted = State(initialValue: initialDisclosure.isTrailExpanded)
    }

    static func summaryLabel(for trail: ActivityTrail) -> String? {
        guard let duration = trail.duration else { return nil }
        let total = Int(duration.rounded())
        let minutes = total / 60
        let seconds = total % 60
        if minutes == 0 { return "Worked for \(seconds)s" }
        return "Worked for \(minutes)m \(seconds)s"
    }

    var body: some View {
        let summary = Self.summaryLabel(for: trail)

        VStack(alignment: .leading, spacing: 0) {
            if let summary { summaryRow(summary) }
            trailItemsViewport
        }
        .frame(width: width, alignment: .leading)
        .onChange(of: trail) { oldTrail, newTrail in
            var next = disclosure
            next.update(from: oldTrail, to: newTrail)
            disclosure = next
            accessibilityExpandedItemID = next.expandedItemID
            isTrailContentMounted = next.isTrailExpanded
            outerRevealHeight = next.isTrailExpanded ? nil : 0
        }
    }

    @ViewBuilder
    private var trailItemsViewport: some View {
        if let outerRevealHeight {
            trailItems
                .modifier(ActivityRevealHeightModifier(
                    height: outerRevealHeight,
                    id: summaryDiagnosticID,
                    onHeightUpdate: scrollAnchor.revealHeightDidUpdate
                ))
        } else {
            trailItems
        }
    }

    private var trailItems: some View {
        ZStack(alignment: .topLeading) {
            if isTrailContentMounted {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(trail.items) { item in
                        itemView(item)
                    }
                }
            }
        }
        .allowsHitTesting(disclosure.isTrailExpanded)
        .accessibilityHidden(!disclosure.isTrailExpanded)
    }

    private func summaryRow(_ text: String) -> some View {
        Button {
            toggleTrail()
        } label: {
            HStack(spacing: DS.Space.s1) {
                Text(text)
                    .textStyle(.trailLabel)
                    .foregroundStyle(DS.Color.inkSecondary)
                    .lineLimit(1)
                chevron(expanded: disclosure.isTrailExpanded)
                Spacer(minLength: 0)
            }
            .frame(height: Self.rowHeight)
            .contentShape(Rectangle())
            .background {
                ZStack {
                    ActivityDisclosureAnchorMarker(anchor: scrollAnchor)
                    ActivityLayoutFrameMarker(id: summaryDiagnosticID)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityValue(summaryAccessibilityValue)
    }

    @ViewBuilder
    private func itemView(_ item: TrailItem) -> some View {
        switch item {
        case let .reasoning(id, text):
            operationRow(icon: .trailTerminal, text: text, diagnosticID: itemDiagnosticID(id.uuidString))
        case let .step(step):
            VStack(alignment: .leading, spacing: 0) {
                if step.imageID != nil {
                    expandableRow(icon: .trailTerminal, text: step.label, id: step.id)
                } else {
                    operationRow(icon: .trailTerminal, text: step.label, diagnosticID: itemDiagnosticID(step.id))
                }
                if let imageID = step.imageID, let data = crop(imageID) {
                    ZStack(alignment: .topLeading) {
                        BoardViewThumbnail(
                            view: BoardView(imageData: data, detail: step.label),
                            onOpen: nil
                        )
                        .allowsHitTesting(disclosure.expandedItemID == step.id)
                        .accessibilityHidden(disclosure.expandedItemID != step.id)
                    }
                    .modifier(
                        ActivityRevealHeightModifier(
                            height: disclosure.expandedItemID == step.id
                                ? BoardViewsMetrics.thumbnail.height
                                : 0,
                            id: itemDiagnosticID(step.id),
                            onHeightUpdate: scrollAnchor.revealHeightDidUpdate
                        )
                    )
                }
            }
        case let .search(search):
            VStack(alignment: .leading, spacing: 0) {
                if search.sources.isEmpty {
                    operationRow(
                        icon: .trailGlobe,
                        text: Self.searchLabel(count: 0),
                        diagnosticID: itemDiagnosticID(search.id)
                    )
                } else {
                    expandableRow(
                        icon: .trailGlobe,
                        text: Self.searchLabel(count: search.sources.count),
                        id: search.id,
                        iconTint: DS.Color.brand
                    )
                    ZStack(alignment: .topLeading) {
                        TrailSourceList(
                            sources: search.sources,
                            isAccessibilityHidden: accessibilityExpandedItemID != search.id
                        )
                        .equatable()
                        .frame(
                            height: CGFloat(search.sources.count) * TrailSourceRow.rowHeight,
                            alignment: .top
                        )
                        .disabled(disclosure.expandedItemID != search.id)
                        .allowsHitTesting(disclosure.expandedItemID == search.id)
                        .accessibilityHidden(accessibilityExpandedItemID != search.id)
                    }
                    .modifier(
                        ActivityRevealHeightModifier(
                            height: disclosure.expandedItemID == search.id
                                ? CGFloat(search.sources.count) * TrailSourceRow.rowHeight
                                : 0,
                            id: itemDiagnosticID(search.id),
                            onHeightUpdate: scrollAnchor.revealHeightDidUpdate
                        )
                    )
                }
            }
        }
    }

    private func operationRow(icon: Icon, text: String, diagnosticID: String) -> some View {
        HStack(spacing: Self.iconTextGap) {
            IconView(icon, size: Self.iconSize)
                .frame(width: Self.iconSize)
            Text(text)
                .textStyle(.trailReasoning)
                .foregroundStyle(DS.Color.inkSecondary)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .frame(height: Self.rowHeight)
        .background(ActivityLayoutFrameMarker(id: diagnosticID))
    }

    private func expandableRow(
        icon: Icon,
        text: String,
        id: String,
        iconTint: Color = DS.Color.icon
    ) -> some View {
        Button {
            toggleItem(id)
        } label: {
            HStack(spacing: Self.iconTextGap) {
                IconView(icon, size: Self.iconSize, tint: iconTint)
                    .frame(width: Self.iconSize)
                HStack(spacing: DS.Space.s1) {
                    Text(text)
                        .textStyle(.trailLabel)
                        .foregroundStyle(DS.Color.inkSecondary)
                        .lineLimit(1)
                    chevron(expanded: disclosure.expandedItemID == id)
                }
                Spacer(minLength: 0)
            }
            .frame(height: Self.rowHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(disclosure.expandedItemID == id ? "Expanded" : "Collapsed")
        .background(ActivityLayoutFrameMarker(id: itemDiagnosticID(id)))
    }

    private func toggleTrail() {
        guard !isDisclosureAnimating else { return }
        isDisclosureAnimating = true
        var next = disclosure
        next.toggleTrail()
        if !next.isTrailExpanded {
            accessibilityExpandedItemID = nil
        }
        let initialHeight = revealedHeight(for: disclosure)
        let finalHeight = revealedHeight(for: next)
        if next.isTrailExpanded {
            isTrailContentMounted = true
            DispatchQueue.main.async {
                scrollAnchor.animate(
                    anchorID: summaryDiagnosticID,
                    revealID: summaryDiagnosticID,
                    from: initialHeight,
                    to: finalHeight
                ) {
                    disclosure = next
                    outerRevealHeight = finalHeight
                } completion: {
                    outerRevealHeight = nil
                    accessibilityExpandedItemID = next.expandedItemID
                    isDisclosureAnimating = false
                }
            }
        } else {
            // Materialize the natural open height as a fixed viewport first;
            // the following run-loop turn animates only that viewport to zero.
            outerRevealHeight = initialHeight
            DispatchQueue.main.async {
                scrollAnchor.animate(
                    anchorID: summaryDiagnosticID,
                    revealID: summaryDiagnosticID,
                    from: initialHeight,
                    to: finalHeight
                ) {
                    disclosure = next
                    outerRevealHeight = finalHeight
                } completion: {
                    accessibilityExpandedItemID = nil
                    isTrailContentMounted = false
                    isDisclosureAnimating = false
                }
            }
        }
    }

    private func toggleItem(_ id: String) {
        guard !isDisclosureAnimating else { return }
        isDisclosureAnimating = true
        var next = disclosure
        next.toggleItem(id)
        if next.expandedItemID == nil {
            accessibilityExpandedItemID = nil
        }
        let initialHeight = detailHeight(for: disclosure.expandedItemID)
        let finalHeight = detailHeight(for: next.expandedItemID)
        scrollAnchor.animate(
            anchorID: itemDiagnosticID(id),
            revealID: itemDiagnosticID(id),
            from: initialHeight,
            to: finalHeight
        ) {
            disclosure = next
        } completion: {
            accessibilityExpandedItemID = next.expandedItemID
            isDisclosureAnimating = false
        }
    }

    private func detailHeight(for expandedItemID: String?) -> CGFloat {
        guard let expandedItemID,
              let item = trail.items.first(where: { $0.id == expandedItemID })
        else { return 0 }
        switch item {
        case let .search(search):
            return CGFloat(search.sources.count) * TrailSourceRow.rowHeight
        case let .step(step):
            guard let imageID = step.imageID, crop(imageID) != nil else { return 0 }
            return BoardViewsMetrics.thumbnail.height
        case .reasoning:
            return 0
        }
    }

    private func revealedHeight(for state: TrailDisclosureState) -> CGFloat {
        guard state.isTrailExpanded else { return 0 }
        var height = CGFloat(trail.items.count) * Self.rowHeight
        guard let expandedID = state.expandedItemID,
              let item = trail.items.first(where: { $0.id == expandedID })
        else { return height }

        switch item {
        case let .search(search):
            height += CGFloat(search.sources.count) * TrailSourceRow.rowHeight
        case let .step(step):
            if let imageID = step.imageID, crop(imageID) != nil {
                height += BoardViewsMetrics.thumbnail.height
            }
        case .reasoning:
            break
        }
        return height
    }

    private func chevron(expanded: Bool) -> some View {
        IconView(.uiChevronDown, size: Self.chevronSize)
            .rotationEffect(.degrees(expanded ? 0 : -90))
            .accessibilityHidden(true)
    }

    static func searchLabel(count: Int) -> String {
        count == 1 ? "Searched 1 website" : "Searched \(count) websites"
    }

    private var summaryAccessibilityValue: String {
        let state = disclosure.isTrailExpanded ? "Expanded" : "Collapsed"
        guard ProcessInfo.processInfo.arguments.contains("--ui-activity-anchor-logs") else {
            return state
        }
        let range = scrollAnchor.completedDriftRange
        let frames = ActivityLayoutFrameRegistry.shared
        return "\(state); anchor drift \(String(format: "%.2f", Double(scrollAnchor.completedMaxDrift))); " +
            "range \(String(format: "%.2f", Double(range.lowerBound)))...\(String(format: "%.2f", Double(range.upperBound))); " +
            "above drift \(String(format: "%.2f", Double(frames.completedStationaryDrift))); " +
            "worst above \(frames.completedWorstStationaryID); " +
            "below spread \(String(format: "%.2f", Double(frames.completedMovingSpread))); " +
            "reversals \(frames.completedDirectionReversals); " +
            "max step \(String(format: "%.2f", Double(frames.completedMaxFrameStep))); " +
            "samples \(frames.completedSampleCount)"
    }

    private var summaryDiagnosticID: String { "\(diagnosticNamespace):summary" }
    private func itemDiagnosticID(_ id: String) -> String { "\(diagnosticNamespace):item:\(id)" }

    private static let iconSize: CGFloat = 20
    private static let chevronSize: CGFloat = 16
    private static let iconTextGap: CGFloat = 9
    private static let rowHeight: CGFloat = 40
}
