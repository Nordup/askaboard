import PencilKit
import SwiftUI

enum TutorPanelResizeCorner: String, CaseIterable, Sendable {
    case topLeading
    case topTrailing
    case bottomLeading
    case bottomTrailing

    var accessibilityName: String {
        switch self {
        case .topLeading: "top leading"
        case .topTrailing: "top trailing"
        case .bottomLeading: "bottom leading"
        case .bottomTrailing: "bottom trailing"
        }
    }
}

/// Pure geometry for the floating tutor panel. Keeping the calculations outside
/// the view makes resize/drag behavior predictable and directly testable.
enum TutorPanelLayout {
    struct ResizeResult: Equatable {
        let size: CGSize
        let offset: CGSize
    }

    static let defaultExpandedSize = CGSize(width: 330, height: 300)
    static let minimumExpandedSize = CGSize(width: 260, height: 220)
    static let collapsedSize = CGSize(width: 72, height: 72)

    static func visibleRect(
        in available: CGSize,
        bottomInset: CGFloat,
        leadingInset: CGFloat = 16,
        trailingInset: CGFloat = 22,
        topInset: CGFloat = 16
    ) -> CGRect {
        CGRect(
            x: leadingInset,
            y: topInset,
            width: max(0, available.width - leadingInset - trailingInset),
            height: max(0, available.height - topInset - bottomInset)
        )
    }

    static func anchor(in available: CGSize, bottomInset: CGFloat, trailingInset: CGFloat = 22) -> CGPoint {
        CGPoint(x: available.width - trailingInset, y: available.height - bottomInset)
    }

    static func clampedSize(
        _ proposed: CGSize,
        in available: CGSize,
        bottomInset: CGFloat = 38,
        topInset: CGFloat = 0
    ) -> CGSize {
        let maximumWidth = max(1, available.width - 38)
        let maximumHeight = max(1, available.height - topInset - bottomInset)
        let minimumWidth = min(minimumExpandedSize.width, maximumWidth)
        let minimumHeight = min(minimumExpandedSize.height, maximumHeight)
        return CGSize(
            width: min(max(proposed.width, minimumWidth), maximumWidth),
            height: min(max(proposed.height, minimumHeight), maximumHeight)
        )
    }

    static func resized(
        from start: CGSize,
        translation: CGSize,
        corner: TutorPanelResizeCorner,
        in available: CGSize,
        bottomInset: CGFloat = 38,
        topInset: CGFloat = 0
    ) -> CGSize {
        let growsRight = corner == .topTrailing || corner == .bottomTrailing
        let growsDown = corner == .bottomLeading || corner == .bottomTrailing
        let width = start.width + (growsRight ? translation.width : -translation.width)
        let height = start.height + (growsDown ? translation.height : -translation.height)
        return clampedSize(
            CGSize(width: width, height: height),
            in: available,
            bottomInset: bottomInset,
            topInset: topInset
        )
    }

    /// Resizes the panel while keeping the opposite corner fixed. The panel is
    /// bottom-trailing anchored, so trailing and bottom handles also need an
    /// offset adjustment for the grabbed corner to follow the drag.
    static func resizedLayout(
        from startSize: CGSize,
        startOffset: CGSize,
        translation: CGSize,
        corner: TutorPanelResizeCorner,
        in available: CGSize,
        bottomInset: CGFloat = 38,
        topInset: CGFloat = 0
    ) -> ResizeResult {
        let size = resized(
            from: startSize,
            translation: translation,
            corner: corner,
            in: available,
            bottomInset: bottomInset,
            topInset: topInset
        )
        let widthDelta = size.width - startSize.width
        let heightDelta = size.height - startSize.height
        var offset = startOffset
        if corner == .topTrailing || corner == .bottomTrailing {
            offset.width += widthDelta
        }
        if corner == .bottomLeading || corner == .bottomTrailing {
            offset.height += heightDelta
        }
        return ResizeResult(size: size, offset: offset)
    }

    static func clampedOffset(
        _ proposed: CGSize,
        panelSize: CGSize,
        visibleRect: CGRect,
        anchor: CGPoint
    ) -> CGSize {
        let baseX = anchor.x - panelSize.width
        let baseY = anchor.y - panelSize.height
        let minimumX = visibleRect.minX - baseX
        let maximumX = visibleRect.maxX - panelSize.width - baseX
        let minimumY = visibleRect.minY - baseY
        let maximumY = visibleRect.maxY - panelSize.height - baseY
        return CGSize(
            width: min(max(proposed.width, minimumX), max(minimumX, maximumX)),
            height: min(max(proposed.height, minimumY), max(minimumY, maximumY))
        )
    }
}

struct WorkspaceView: View {
    @EnvironmentObject private var store: TutorStore
    @StateObject private var capture = CanvasCapture()
    @State private var selectionMode = false
    @State private var selectionStart: CGPoint?
    @State private var selectionRect: CGRect?
    @State private var panelOffset: CGSize = .zero
    @State private var panelDragStart: CGSize?
    @State private var panelExpanded = true
    @State private var panelSize = TutorPanelLayout.defaultExpandedSize
    @State private var panelResizeStartSize: CGSize?
    @State private var panelResizeStartOffset: CGSize?
    @State private var showingFullChat = false
    @State private var showingClearConfirmation = false
    @State private var showingSettings = false
    @State private var showPlan = false

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .topLeading) {
                Color(uiColor: .systemGroupedBackground).ignoresSafeArea()
                PencilCanvasView(
                    capture: capture,
                    initialDrawingData: store.session.drawingData,
                    isActive: !showingFullChat,
                    onDrawingChange: store.updateDrawing,
                    onUndo: capture.undo,
                    onRedo: capture.redo
                )
                .background(Color(uiColor: .systemBackground))
                .ignoresSafeArea()

                if selectionMode {
                    selectionLayer
                }

                VStack(alignment: .leading, spacing: 12) {
                    topBar
                    exerciseCard
                    Spacer()
                }
                .padding(.top, 10)
                .padding(.horizontal, 14)

                VStack {
                    Spacer()
                    bottomToolbar
                }
                .padding(.horizontal, 14)
                // PKToolPicker owns the lowest edge of the canvas. Keep the compact
                // session actions clearly above its native palette on every iPad size.
                .padding(.bottom, 126)

                if !showingFullChat {
                    FloatingTutorPanel(
                        expanded: $panelExpanded,
                        text: $panelInput,
                        panelSize: panelSize,
                        latestMessages: panelMessages,
                        evaluationText: store.evaluationText,
                        errorMessage: store.errorMessage,
                        isLoading: store.isLoading || store.isEvaluating,
                        onSend: { value in store.send(value) },
                        onDontKnow: store.sayIDontKnow,
                        onEvaluate: evaluateFullCanvas,
                        onClearEvaluation: store.clearEvaluation,
                        onExpandChat: { showingFullChat = true },
                        onPanelDragChanged: { value in panelDragChanged(value, in: geometry.size) },
                        onPanelDragEnded: { value in panelDragEnded(value, in: geometry.size) },
                        onResizeChanged: { corner, translation in
                            panelResizeChanged(corner, translation: translation, in: geometry.size)
                        },
                        onResizeEnded: { corner, translation in
                            panelResizeEnded(corner, translation: translation, in: geometry.size)
                        }
                    )
                    .frame(width: panelFrameSize.width, height: panelFrameSize.height, alignment: .topLeading)
                    .clipped()
                    .padding(.trailing, 22)
                    .padding(.bottom, panelExpanded ? 210 : 150)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                    .offset(panelOffset)
                    .onChange(of: geometry.size) { _, newSize in
                        panelSize = TutorPanelLayout.clampedSize(
                            panelSize,
                            in: newSize,
                            bottomInset: panelBottomInset(),
                            topInset: 16
                        )
                        panelOffset = clampedPanelOffset(panelOffset, in: newSize)
                    }
                    .onChange(of: panelExpanded) { _, _ in
                        panelSize = TutorPanelLayout.clampedSize(
                            panelSize,
                            in: geometry.size,
                            bottomInset: panelBottomInset(),
                            topInset: 16
                        )
                        panelOffset = clampedPanelOffset(panelOffset, in: geometry.size)
                    }
                }

                if showingFullChat {
                    TutorChatView(onBackToWhiteboard: { showingFullChat = false })
                        .frame(width: geometry.size.width, height: geometry.size.height)
                        .background(Color(uiColor: .systemBackground))
                        .zIndex(10)
                }
            }
            .sheet(isPresented: $showingSettings) { SettingsView() }
            .sheet(isPresented: $showPlan) {
                if let plan = store.session.plan { SessionPlanSheet(plan: plan) }
            }
            .confirmationDialog("Clear all handwriting?", isPresented: $showingClearConfirmation, titleVisibility: .visible) {
                Button("Clear board", role: .destructive) {
                    capture.clear()
                    store.clearDrawing()
                    selectionRect = nil
                }
                Button("Cancel", role: .cancel) { }
            } message: {
                Text("This removes the current PencilKit drawing from this session.")
            }
        }
    }

    @State private var panelInput = ""

    private var panelFrameSize: CGSize {
        panelExpanded ? panelSize : TutorPanelLayout.collapsedSize
    }

    private func panelBottomInset() -> CGFloat {
        panelExpanded ? 210 : 150
    }

    private var panelMessages: [TutorMessage] {
        let messages = Array(store.session.messages.suffix(5))
        guard let evaluationMessageID = store.evaluationMessageID,
              store.evaluationText != nil else {
            return messages
        }
        // The highlighted card renders the evaluation turn separately. Hide only
        // that same turn from the compact transcript while it is highlighted;
        // dismissing the card restores it from the persisted session history.
        return messages.filter { $0.id != evaluationMessageID }
    }

    private var topBar: some View {
        HStack(spacing: 10) {
            Button { showingFullChat = true } label: {
                Image(systemName: "chevron.left")
                    .font(.headline.weight(.bold))
                    .frame(width: 42, height: 42)
            }
            .buttonStyle(.bordered)
            // Distinct from the floating panel's control, which opens the same
            // overlay. Without an explicit identifier this button inherits the
            // SF Symbol name ("chevron.left"), and sharing the panel's label
            // left two indistinguishable "Open full tutor chat" buttons in the
            // accessibility tree.
            .accessibilityLabel("Open full tutor chat")
            .accessibilityIdentifier("open-full-chat")

            VStack(alignment: .leading, spacing: 2) {
                Text(store.session.exercise?.title ?? "Workspace")
                    .font(.headline.weight(.bold))
                Text("Apple Pencil workspace")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("\(store.session.selectedModel.displayName) · \(store.session.reasoningEffort.statusName) reasoning")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            Button { showPlan = true } label: {
                Label("Plan", systemImage: "map")
                    .labelStyle(.titleAndIcon)
            }
            .buttonStyle(.bordered)
            .accessibilityLabel("Show session plan")
            Button { showingSettings = true } label: {
                Image(systemName: "slider.horizontal.3")
                    .frame(width: 42, height: 42)
            }
            .buttonStyle(.bordered)
            .accessibilityLabel("Tutor settings")
        }
        .padding(8)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color.primary.opacity(0.1)))
    }

    private var exerciseCard: some View {
        Group {
            if let exercise = store.session.exercise {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Label("EXERCISE", systemImage: "lightbulb.fill")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.orange)
                        Spacer()
                        Text("Step \((store.session.plan?.currentStep ?? 0) + 1) of \(store.session.plan?.steps.count ?? 3)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Text(exercise.prompt)
                        .font(.body.weight(.medium))
                        .fixedSize(horizontal: false, vertical: true)
                    Text(exercise.hint)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(16)
                .frame(maxWidth: 470, alignment: .leading)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color.orange.opacity(0.25)))
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Exercise: \(exercise.prompt). Hint: \(exercise.hint)")
            }
        }
    }

    private var selectionLayer: some View {
        ZStack {
            Color.indigo.opacity(0.04)
                .contentShape(Rectangle())
                .gesture(selectionGesture)
            if let selectionRect {
                Rectangle()
                    .fill(Color.indigo.opacity(0.11))
                    .overlay(Rectangle().stroke(Color.indigo, style: StrokeStyle(lineWidth: 2, dash: [7, 5])))
                    .frame(width: selectionRect.width, height: selectionRect.height)
                    .position(x: selectionRect.midX, y: selectionRect.midY)
                    .allowsHitTesting(false)
                Text("Region ready to evaluate")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.indigo)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(.regularMaterial, in: Capsule())
                    .position(x: selectionRect.midX, y: max(28, selectionRect.minY - 18))
                    .allowsHitTesting(false)
            }
        }
        .ignoresSafeArea()
    }

    private var selectionGesture: some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                if selectionStart == nil { selectionStart = value.startLocation }
                selectionRect = normalizedRect(from: selectionStart ?? value.startLocation, to: value.location)
            }
            .onEnded { value in
                selectionRect = normalizedRect(from: selectionStart ?? value.startLocation, to: value.location)
                selectionStart = nil
            }
    }

    private var bottomToolbar: some View {
        ViewThatFits(in: .horizontal) {
            actionBar(compact: false)
            actionBar(compact: true)
        }
    }

    @ViewBuilder
    private func actionBar(compact: Bool) -> some View {
        HStack(spacing: compact ? 6 : 8) {
            Button {
                capture.centerOnContent(animated: true)
            } label: {
                if compact {
                    Image(systemName: "scope")
                        .frame(width: 40, height: 40)
                } else {
                    Label("Center", systemImage: "scope")
                }
            }
            .font(.subheadline.weight(.semibold))
            .buttonStyle(.bordered)
            .tint(.primary)
            .accessibilityIdentifier("center-on-work")
            .accessibilityLabel("Center on my work")

            Button {
                selectionMode.toggle()
                if !selectionMode { selectionRect = nil }
            } label: {
                if compact {
                    Image(systemName: "rectangle.dashed")
                        .frame(width: 40, height: 40)
                } else {
                    Label(selectionMode ? "Drawing region…" : "Select region", systemImage: "rectangle.dashed")
                }
            }
            .font(.subheadline.weight(.semibold))
            .buttonStyle(.bordered)
            .tint(selectionMode ? .indigo : .primary)
            .accessibilityLabel(selectionMode ? "Drag to select a region" : "Select a region for evaluation")

            if selectionRect != nil {
                Button {
                    evaluateRegion()
                } label: {
                    if compact {
                        Image(systemName: "checkmark.seal")
                            .frame(width: 40, height: 40)
                    } else {
                        Label("Evaluate region", systemImage: "checkmark.seal")
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .accessibilityIdentifier("evaluate-region")
            } else {
                Button(action: evaluateFullCanvas) {
                    if compact {
                        Image(systemName: "checkmark.seal")
                            .frame(width: 40, height: 40)
                    } else {
                        Label("Evaluate board", systemImage: "checkmark.seal")
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .accessibilityIdentifier("evaluate-board")
            }

            Button {
                showingClearConfirmation = true
            } label: {
                if compact {
                    Image(systemName: "trash")
                        .frame(width: 40, height: 40)
                } else {
                    Label("Clear", systemImage: "trash")
                }
            }
            .buttonStyle(.bordered)
            .tint(.red)
            .accessibilityLabel("Clear board")
        }
        .padding(9)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 19, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 19).stroke(Color.primary.opacity(0.1)))
    }

    private func panelDragChanged(_ value: DragGesture.Value, in size: CGSize) {
        if panelDragStart == nil { panelDragStart = panelOffset }
        let start = panelDragStart ?? .zero
        let proposed = CGSize(width: start.width + value.translation.width, height: start.height + value.translation.height)
        panelOffset = clampedPanelOffset(proposed, in: size)
    }

    private func panelDragEnded(_ value: DragGesture.Value, in size: CGSize) {
        let start = panelDragStart ?? panelOffset
        let proposed = CGSize(width: start.width + value.translation.width, height: start.height + value.translation.height)
        panelOffset = clampedPanelOffset(proposed, in: size)
        panelDragStart = nil
    }

    private func clampedPanelOffset(_ proposed: CGSize, in size: CGSize) -> CGSize {
        TutorPanelLayout.clampedOffset(
            proposed,
            panelSize: panelFrameSize,
            visibleRect: TutorPanelLayout.visibleRect(in: size, bottomInset: panelBottomInset()),
            anchor: TutorPanelLayout.anchor(in: size, bottomInset: panelBottomInset())
        )
    }

    private func panelResizeChanged(
        _ corner: TutorPanelResizeCorner,
        translation: CGSize,
        in size: CGSize
    ) {
        if panelResizeStartSize == nil {
            panelResizeStartSize = panelSize
            panelResizeStartOffset = panelOffset
        }
        let result = TutorPanelLayout.resizedLayout(
            from: panelResizeStartSize ?? panelSize,
            startOffset: panelResizeStartOffset ?? panelOffset,
            translation: translation,
            corner: corner,
            in: size,
            bottomInset: panelBottomInset(),
            topInset: 16
        )
        panelSize = result.size
        panelOffset = TutorPanelLayout.clampedOffset(
            result.offset,
            panelSize: panelFrameSize,
            visibleRect: TutorPanelLayout.visibleRect(in: size, bottomInset: panelBottomInset()),
            anchor: TutorPanelLayout.anchor(in: size, bottomInset: panelBottomInset())
        )
    }

    private func panelResizeEnded(
        _ corner: TutorPanelResizeCorner,
        translation: CGSize,
        in size: CGSize
    ) {
        panelResizeChanged(corner, translation: translation, in: size)
        panelResizeStartSize = nil
        panelResizeStartOffset = nil
    }

    private func normalizedRect(from start: CGPoint, to end: CGPoint) -> CGRect {
        CGRect(x: min(start.x, end.x), y: min(start.y, end.y), width: abs(end.x - start.x), height: abs(end.y - start.y))
    }

    private func evaluateFullCanvas() {
        guard let data = capture.snapshotAllInkData() else { return }
        selectionMode = false
        selectionRect = nil
        store.evaluate(imageData: data, regionDescription: "the whole board")
        panelExpanded = true
    }

    private func evaluateRegion() {
        guard let selectionRect, let data = capture.snapshotData(region: selectionRect) else { return }
        store.evaluate(imageData: data, regionDescription: "the selected rectangle")
        panelExpanded = true
    }
}

struct FloatingTutorPanel: View {
    @Binding var expanded: Bool
    @Binding var text: String
    let panelSize: CGSize
    let latestMessages: [TutorMessage]
    let evaluationText: String?
    let errorMessage: String?
    let isLoading: Bool
    let onSend: (String) -> Void
    let onDontKnow: () -> Void
    let onEvaluate: () -> Void
    let onClearEvaluation: () -> Void
    let onExpandChat: () -> Void
    let onPanelDragChanged: (DragGesture.Value) -> Void
    let onPanelDragEnded: (DragGesture.Value) -> Void
    let onResizeChanged: (TutorPanelResizeCorner, CGSize) -> Void
    let onResizeEnded: (TutorPanelResizeCorner, CGSize) -> Void
    @FocusState private var focused: Bool

    private var panelDragGesture: some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { value in onPanelDragChanged(value) }
            .onEnded { value in onPanelDragEnded(value) }
    }

    private var latestMessageID: UUID? {
        latestMessages.last?.id
    }

    var body: some View {
        if expanded {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    // Keep the drag surface in the non-interactive title area so
                    // it cannot steal touches from the expand/collapse controls.
                    HStack(spacing: 8) {
                        Image(systemName: "sparkles")
                            .foregroundStyle(.indigo)
                        Text("Tutor")
                            .font(.headline.weight(.bold))
                        Text("on the board")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    // Keep the hit target to the title's intrinsic width; a
                    // flexible frame here could extend underneath the buttons.
                    .frame(minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                    .overlay(alignment: .trailing) {
                        Image(systemName: "line.3.horizontal")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                            .padding(.trailing, 4)
                            .allowsHitTesting(false)
                    }
                    .gesture(panelDragGesture)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Move tutor panel")
                    .accessibilityHint("Drag this area to reposition the floating tutor panel")
                    .accessibilityIdentifier("drag-tutor-panel")
                    Spacer(minLength: 0)
                    Button(action: onExpandChat) {
                        Image(systemName: "arrow.up.left.and.arrow.down.right")
                            .frame(width: 30, height: 30)
                    }
                    .buttonStyle(.bordered)
                    .accessibilityLabel("Expand tutor chat to full screen")
                    .accessibilityIdentifier("expand-full-chat")
                    Button { expanded = false } label: {
                        Image(systemName: "minus")
                            .frame(width: 30, height: 30)
                    }
                    .buttonStyle(.bordered)
                    .accessibilityLabel("Collapse tutor")
                }
                .padding(13)

                Divider()
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 9) {
                            ForEach(latestMessages) { message in
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(message.role == .learner ? "You" : "Tutor")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(.secondary)
                                    if message.role == .tutor {
                                        TutorStructuredText(message.text)
                                            .font(.subheadline)
                                    } else {
                                        LearnerLiteralText(message.text)
                                            .font(.subheadline)
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 8)
                                .background(
                                    message.role == .learner
                                        ? Color.indigo.opacity(0.08)
                                        : Color.secondary.opacity(0.08),
                                    in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                                )
                                .id(message.id)
                            }
                            if let evaluationText {
                                VStack(alignment: .leading, spacing: 7) {
                                    Label("Feedback", systemImage: "checkmark.seal.fill")
                                        .font(.caption.weight(.bold))
                                        .foregroundStyle(.green)
                                    TutorStructuredText(evaluationText)
                                        .font(.subheadline)
                                    Button("Dismiss feedback", action: onClearEvaluation)
                                        .font(.caption)
                                        .buttonStyle(.borderless)
                                }
                                .padding(10)
                                .background(Color.green.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
                                .id("evaluation")
                            }
                            if let errorMessage {
                                HStack(alignment: .top, spacing: 8) {
                                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(errorMessage).font(.caption)
                                        Button("Retry", action: onEvaluate)
                                            .font(.caption.weight(.semibold))
                                            .buttonStyle(.borderless)
                                    }
                                }
                                .padding(10)
                                .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
                            }
                            if isLoading {
                                ProgressView().controlSize(.small)
                            }
                        }
                        .padding(13)
                    }
                    // The title row now contains the drag target. Leave enough
                    // room for it plus the composer/actions even at the minimum
                    // resized height, while preserving a useful message viewport.
                    .frame(maxHeight: max(56, panelSize.height - 166))
                    .onChange(of: latestMessageID) { oldID, newID in
                        guard let newID, newID != oldID else { return }
                        withAnimation(.easeOut(duration: 0.2)) {
                            proxy.scrollTo(newID, anchor: .bottom)
                        }
                    }
                    .onChange(of: evaluationText) { _, newValue in
                        guard newValue != nil else { return }
                        proxy.scrollTo("evaluation", anchor: .top)
                    }
                }
                Divider()
                HStack(spacing: 7) {
                    TextField("Ask a question…", text: $text, axis: .vertical)
                        .textFieldStyle(.plain)
                        .font(.subheadline)
                        .lineLimit(1...3)
                        .focused($focused)
                        .onSubmit(send)
                        .accessibilityLabel("Message tutor while working")
                    Button(action: send) {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.title2)
                    }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isLoading)
                    .accessibilityLabel("Send tutor message")
                }
                .padding(11)
                HStack(spacing: 7) {
                    Button("I don’t know") { onDontKnow() }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    Button { onEvaluate() } label: {
                        Label("Evaluate", systemImage: "checkmark.seal")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
                .padding(.horizontal, 11)
                .padding(.bottom, 11)
            }
            .background(.thickMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.indigo.opacity(0.25), lineWidth: 1.5))
            .shadow(color: .black.opacity(0.16), radius: 22, y: 8)
            .overlay(alignment: .bottomLeading) {
                resizeHandle(.bottomLeading)
            }
            .overlay(alignment: .bottomTrailing) {
                resizeHandle(.bottomTrailing)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Floating tutor panel")
        } else {
            Button { expanded = true } label: {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: "sparkles")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(.white)
                        .frame(width: 62, height: 62)
                        .background(Color.indigo.gradient, in: RoundedRectangle(cornerRadius: 19, style: .continuous))
                    Circle().fill(.orange).frame(width: 12, height: 12).offset(x: 1, y: -1)
                }
            }
            .buttonStyle(.plain)
            .shadow(color: .black.opacity(0.2), radius: 12, y: 5)
            .accessibilityLabel("Expand tutor")
        }
    }

    private func send() {
        let value = text
        text = ""
        onSend(value)
        focused = true
    }

    private func resizeHandle(_ corner: TutorPanelResizeCorner) -> some View {
        Rectangle()
            .fill(Color.primary.opacity(0.001))
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { value in onResizeChanged(corner, value.translation) }
                    .onEnded { value in onResizeEnded(corner, value.translation) }
            )
            .accessibilityLabel("Resize tutor panel from \(corner.accessibilityName) corner")
            .accessibilityHint("Drag to resize the tutor panel")
            .accessibilityIdentifier("resize-tutor-panel-\(corner.rawValue)")
            .accessibilityAddTraits(.isButton)
    }

}

struct SessionPlanSheet: View {
    let plan: SessionPlan
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("Goal") { Text(plan.goal) }
                Section("Steps") {
                    ForEach(Array(plan.steps.enumerated()), id: \.offset) { index, step in
                        Label(step, systemImage: "\(index + 1).circle.fill")
                    }
                }
                Section("What success looks like") {
                    ForEach(plan.outcomes, id: \.self) { Text($0) }
                }
            }
            .navigationTitle("Session plan")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}

struct SettingsView: View {
    @EnvironmentObject private var store: TutorStore
    @Environment(\.dismiss) private var dismiss
    @AppStorage(AppearancePreference.key) private var appearanceRawValue = AppearancePreference.defaultValue.rawValue
    @State private var apiKey = ""
    @State private var savedMessage: String?
    @State private var showingResetConfirmation = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Appearance") {
                    Picker("Theme", selection: appearanceBinding) {
                        ForEach(AppAppearance.allCases) { appearance in
                            Text(appearance.displayName).tag(appearance)
                        }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("appearance-picker")
                }

                Section {
                    Picker("Tutor model", selection: Binding(get: { store.session.selectedModel }, set: { store.setModel($0) })) {
                        ForEach(ModelChoice.allCases) { model in
                            VStack(alignment: .leading) {
                                Text(model.displayName)
                                Text(model.caption(for: store.session.reasoningEffort))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .tag(model)
                        }
                    }
                    .pickerStyle(.navigationLink)
                    Picker("Reasoning effort", selection: Binding(get: { store.session.reasoningEffort }, set: { store.setReasoningEffort($0) })) {
                        ForEach(ReasoningEffort.allCases) { effort in
                            VStack(alignment: .leading) {
                                Text(effort.displayName)
                                Text(effort.caption)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .tag(effort)
                        }
                    }
                    .pickerStyle(.navigationLink)
                    .accessibilityIdentifier("reasoning-effort-picker")
                } header: {
                    Text("Quality route")
                } footer: {
                    Text("New and reset sessions default to Luna with high reasoning. Adjust effort when you want faster replies or more depth.")
                }

                Section {
                    SecureField("sk-…", text: $apiKey)
                        .textContentType(.password)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .onSubmit(saveKey)
                    Button("Save key in Keychain", action: saveKey)
                        .disabled(apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if let savedMessage { Text(savedMessage).font(.caption).foregroundStyle(.green) }
                    if store.usesLiveTutor {
                        Button("Remove saved key", role: .destructive) {
                            if store.removeAPIKey() {
                                savedMessage = "Key removed. Add a key to resume live tutoring."
                            }
                        }
                    }
                } header: {
                    Text("OpenAI API key")
                } footer: {
                    Text("Prototype-only: the key is read directly by this app and stored in Keychain, never UserDefaults or source. A production app should use a backend/proxy so the key never reaches the client.")
                }

                Section("Session") {
                    Button("Reset current session", role: .destructive) { showingResetConfirmation = true }
                }
                Section("About this prototype") {
                    Text("Without a key, the app shows setup guidance instead of routing requests to a hidden fallback. An explicit DEBUG demo launch is available for tests. Continuous change detection and cloud sync are future work.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Save key", action: saveKey)
                        .accessibilityIdentifier("save-key-keyboard")
                        .disabled(apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .confirmationDialog("Reset this session?", isPresented: $showingResetConfirmation, titleVisibility: .visible) {
                Button("Reset session", role: .destructive) {
                    store.resetSession()
                    dismiss()
                }
                Button("Cancel", role: .cancel) { }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var appearanceBinding: Binding<AppAppearance> {
        Binding(
            get: { AppAppearance(rawValue: appearanceRawValue) ?? AppearancePreference.defaultValue },
            set: { appearanceRawValue = $0.rawValue }
        )
    }

    private func saveKey() {
        let trimmed = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if store.saveAPIKey(trimmed) {
            savedMessage = "Saved securely in this device’s Keychain."
            apiKey = ""
        }
    }
}
