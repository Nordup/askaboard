import CoreGraphics
import CryptoKit
import ExtendedSwiftMath
import UIKit

extension Notification.Name {
    /// Posted on the main actor after a board element's local artifact lands,
    /// so the layer view can reconcile without owning any render pipeline.
    ///
    /// One name for every kind that draws from a bitmap it does not have yet:
    /// `math_text`, `image`, and `svg` all post it. The payload is
    /// deliberately empty: the observer re-derives what it can now draw rather
    /// than trusting a name in a notification.
    static let boardSceneArtifactReady = Notification.Name("boardSceneArtifactReady")
}

/// One typeset LaTeX fragment, ready to composite.
///
/// `size` is the raster's own size in points, taken at `oversample` times the
/// element's font size; `drawSize` is what it occupies on the board. The
/// oversample is captured on the artifact so a trait change on some later frame
/// cannot rescale notation that is already on the board.
@MainActor
struct MathArtifact {
    let image: CGImage
    let size: CGSize
    /// The oversample the bitmap was typeset at; `drawSize` divides by it.
    let oversample: CGFloat

    /// The notation's size in board points.
    var drawSize: CGSize {
        CGSize(
            width: size.width / oversample,
            height: size.height / oversample
        )
    }

    func draw(in rect: CGRect, into context: CGContext, isFlipped: Bool) {
        guard rect.width > 0, rect.height > 0 else { return }
        context.saveGState()
        context.interpolationQuality = .high
        // A `CGImage` draws y-up. UIKit drawing contexts are y-down, so flip
        // around the destination rectangle's own centre line before handing
        // the bitmap over, or the notation lands upside down. Whether the
        // context is flipped is decided by the caller, before any rotation
        // touches the CTM — a rotated CTM no longer reports it.
        if isFlipped {
            context.translateBy(x: 0, y: rect.midY)
            context.scaleBy(x: 1, y: -1)
            context.translateBy(x: 0, y: -rect.midY)
        }
        context.draw(image, in: rect)
        context.restoreGState()
    }
}

/// In-memory cache of typeset notation, keyed by the LaTeX, the font size, and
/// the colour it is drawn in, with one asynchronous pipeline per entry.
///
/// The shape is `BoardSVGStore`'s and `BoardImageStore`'s: `BoardSceneRenderer`
/// reads a ready artifact synchronously, the layer view schedules the missing
/// ones whenever a scene is installed, and `.boardSceneArtifactReady` tells it
/// when one lands. ExtendedSwiftMath typesets in-process, the same engine the
/// chat transcript renders with, so board notation and chat notation are the
/// same glyphs.
@MainActor
final class BoardMathStore {
    static let shared = BoardMathStore()

    /// How much larger than the board size the bitmap is taken. The board zooms,
    /// and a bitmap rasterized at the logical size goes soft the moment the
    /// learner pinches. This is the largest scale any outer board tile is drawn
    /// at — the board's maximum zoom bucket times the screen's own scale — so
    /// notation stays sharp at 4x on a 2x screen while the learner writes on
    /// it. `BoardSVGStore` prices its figure rasters the same way.
    static var rasterOversample: CGFloat { zoomResolutionScale }

    /// `ZoomBucket`'s maximum times the screen's own scale, with the usual
    /// fallback when a device reports none.
    private static var zoomResolutionScale: CGFloat {
        let screenScale = UITraitCollection.current.displayScale
        let displayScale = screenScale > 0 ? screenScale : 2
        return ZoomBucket.scale(forBucket: ZoomBucket.maxBucket) * displayScale
    }

    /// The resident budget for typeset notation, in bytes.
    ///
    /// `BoardSVGStore`'s and `BoardImageStore`'s budget, and priced the same
    /// way — `bytesPerRow * height`, the bytes the bitmap actually holds.
    ///
    /// This store went without one for longer than its siblings because a
    /// fragment of notation is small, and that is the wrong bound: nothing caps
    /// how *many* there are. A key is the LaTeX, the font size and the colour
    /// together, so one long session in which the model rewrites the same
    /// working at a new size or in a new colour every turn is a new key every
    /// turn, and every one of them stayed resident for the life of the process.
    private let byteLimit: Int

    private var artifacts: [String: MathArtifact] = [:]
    /// Least recently used first — `BoardRasterCache`'s array, at this scale.
    private var order: [String] = []
    private var totalBytes = 0
    private var completed: Set<String> = []
    /// Keys a *draw* must not schedule work for until the next scene install.
    ///
    /// `BoardSVGStore.deferred`, kept here for the hazard the byte cap above
    /// introduces. Eviction takes a key back out of `completed`, because the
    /// LaTeX that made the bitmap is still in the element and the next scene
    /// install must be free to typeset it again — and that is exactly what
    /// would let two fragments that cannot both fit take turns evicting each
    /// other, since every typeset posts `.boardSceneArtifactReady` and the
    /// layer view draws on it.
    ///
    /// Nothing in this file schedules from a draw today: `artifact(for:)` is a
    /// pure read, unlike its two siblings'. So this is the guarantee rather
    /// than the repair — the damper is in place before a draw-path schedule is
    /// ever added, which is the order the other two stores did not get.
    private var deferred: Set<String> = []
    private var inFlight: [String: Task<MathArtifact?, Never>] = [:]

    /// Removes every typeset fragment when the system says memory is short.
    ///
    /// nonisolated(unsafe): deinit must remove a block-based observer, and
    /// deinit is nonisolated in Swift 6. Every other access is MainActor-only,
    /// and by the time deinit runs no other reference exists.
    /// `VoiceAudioSessionController` holds its observers the same way.
    private nonisolated(unsafe) var memoryWarningObserver: (any NSObjectProtocol)?

    init(byteLimit: Int = 64 * 1024 * 1024) {
        self.byteLimit = byteLimit
        memoryWarningObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.purgeUnderMemoryPressure() }
        }
    }

    deinit {
        if let memoryWarningObserver {
            NotificationCenter.default.removeObserver(memoryWarningObserver)
        }
    }

    /// What the resident notation costs right now, for the tests that price it.
    var artifactBytesForTesting: Int { totalBytes }

    /// How many times a fragment has actually been typeset.
    /// `BoardSVGStore.renderPassesForTesting`, for this store's unit of work:
    /// tests read it to tell "answered from memory" from "did the work again".
    /// Nothing in the app looks at it.
    private(set) var typesetPassesForTesting = 0

    /// The LaTeX a fragment is actually typeset from.
    ///
    /// The server passes `latex` through byte for byte and holds no opinion on
    /// the dialect, so the delimiters the model wraps notation in — `$…$`,
    /// `$$…$$`, `\(…\)`, `\[…\]` — arrive intact, and a typesetter handed
    /// `$x$` is being asked to render a dollar sign. Exactly one outer pair
    /// comes off, with the whitespace around and inside it, which is the same
    /// reading the chat pipeline settled on (commits `558b649`, `79d500a`):
    /// a padded span means the bare body, and nothing else changes.
    ///
    /// A lone `$`, a bare `$$`, or a half-open `\(` is not a pair. Stripping
    /// one would silently delete a character of the fragment, so all three are
    /// left exactly as written and fail to typeset instead.
    static func typesettableLatex(_ latex: String) -> String {
        let value = latex.trimmingCharacters(in: .whitespacesAndNewlines)
        // Display delimiters first: `$$` also has the `$` prefix, and `$…$`
        // would otherwise claim `$$x$$` and leave a stray `$` at each end.
        let pairs = [("$$", "$$"), (#"\["#, #"\]"#), (#"\("#, #"\)"#), ("$", "$")]
        for (open, close) in pairs {
            guard value.hasPrefix(open), value.hasSuffix(close),
                  value.count > open.count + close.count
            else { continue }
            return value.dropFirst(open.count).dropLast(close.count)
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return value
    }

    static func cacheKey(latex: String, fontSize: CGFloat, stroke: String) -> String {
        let digest = SHA256.hash(data: Data(typesettableLatex(latex).utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return "\(Int((fontSize * 100).rounded()))|\(stroke)|\(hex)"
    }

    static func cacheKey(for element: MathTextElement) -> String {
        cacheKey(latex: element.latex, fontSize: element.fontSize, stroke: element.style.stroke)
    }

    /// Ensures every `math_text` element in a scene has a typeset scheduled.
    /// Called when a scene is installed, including restored scenes on relaunch.
    func prepare(scene: BoardScene) {
        deferred.removeAll()
        for element in scene.elements {
            if case .mathText(let math) = element {
                prepare(mathElement: math)
            }
        }
    }

    func prepare(mathElement element: MathTextElement) {
        let key = Self.cacheKey(for: element)
        guard !completed.contains(key), !deferred.contains(key),
              inFlight[key] == nil
        else { return }
        schedule(element: element, key: key)
    }

    /// The synchronous read the renderer draws from, and a pure one: a miss
    /// schedules nothing. `math_text` has no frame of its own, so a fragment
    /// without an artifact reports `.zero` bounds and is unmounted rather than
    /// drawn — there is no placeholder pass that would want to start work.
    ///
    /// **It does not touch the LRU order, and must not.** This is not only the
    /// draw path: `BoardSceneRenderer.elementBounds` calls it for a
    /// `math_text` element's *bounds*, and `BoardSceneLayerView.visibleIds`
    /// computes bounds for every element in the scene on every scroll tick. So
    /// this read runs O(scene) times per tick, and `touch` is a linear search
    /// of `order` — the pan path would pay an array scan per fragment per
    /// tick. It is also the wrong order: the cull walks `scene.elements` in
    /// array order, so touching here would rewrite the LRU into scene order
    /// and hand every eviction the wrong victim. The order is maintained where
    /// a fragment is really used — `render(element:)` and `remember(_:for:)`.
    func artifact(for element: MathTextElement) -> MathArtifact? {
        artifacts[Self.cacheKey(for: element)]
    }

    /// Typesets (or awaits an in-flight typeset) and returns the ready
    /// artifact. Used by tests and capture paths that need the notation
    /// composited rather than merely scheduled.
    @discardableResult
    func render(element: MathTextElement) async -> MathArtifact? {
        let key = Self.cacheKey(for: element)
        if let artifact = artifacts[key] {
            touch(key)
            return artifact
        }
        if let task = inFlight[key] {
            return await task.value
        }
        if completed.contains(key) { return nil }
        let task = schedule(element: element, key: key)
        return await task.value
    }

    @discardableResult
    private func schedule(element: MathTextElement, key: String) -> Task<MathArtifact?, Never> {
        let task = Task { @MainActor [weak self] () -> MathArtifact? in
            guard let self else { return nil }
            let artifact = Self.typeset(
                latex: element.latex,
                fontSize: element.fontSize,
                color: UIColor(hex: element.style.stroke) ?? .black
            )
            self.typesetPassesForTesting += 1
            self.inFlight[key] = nil
            // A failure is recorded as completed too. That is what
            // `BoardSVGStore` does with markup that does not parse, and here it
            // covers every failure there is, because there is no transport and
            // no allocation between the fragment and the glyphs.
            // Typesetting is local and deterministic: LaTeX that does not parse
            // now will not parse on the next scene install either, and every
            // install would otherwise re-typeset the same broken fragment.
            // `artifact(for:)` keeps answering nil, so the element stays blank
            // rather than half-drawn.
            self.completed.insert(key)
            if let artifact {
                self.deferred.remove(key)
                self.remember(artifact, for: key)
            }
            NotificationCenter.default.post(name: .boardSceneArtifactReady, object: nil)
            return artifact
        }
        inFlight[key] = task
        return task
    }

    // MARK: - Residency

    private func remember(_ artifact: MathArtifact, for key: String) {
        if let previous = artifacts[key] { totalBytes -= Self.cost(of: previous.image) }
        artifacts[key] = artifact
        totalBytes += Self.cost(of: artifact.image)
        touch(key)
        // `order.count > 1` keeps the fragment that was just typeset even when
        // it alone is over the cap: one enormous expression still draws from
        // memory rather than being typeset again on every frame.
        while totalBytes > byteLimit, let victim = order.first, order.count > 1 {
            order.removeFirst()
            if let evicted = artifacts.removeValue(forKey: victim) {
                totalBytes -= Self.cost(of: evicted.image)
            }
            // Out of `completed` as well, and that pairing is the whole of the
            // rule. `completed` means "attempted, and never to be attempted
            // again", which is right for LaTeX that would not parse and wrong
            // for a bitmap this store chose to drop — the fragment is still in
            // the element, so the next scene install must be free to typeset it
            // again. `deferred` is what keeps that freedom from becoming a loop.
            completed.remove(victim)
            deferred.insert(victim)
        }
    }

    private func touch(_ key: String) {
        if let index = order.firstIndex(of: key) { order.remove(at: index) }
        order.append(key)
    }

    private nonisolated static func cost(of image: CGImage) -> Int {
        image.bytesPerRow * image.height
    }

    /// Drops every typeset fragment when the system says memory is short.
    ///
    /// The keys leave `completed`, because the LaTeX that made each bitmap is
    /// still in the element that carries it and dropping a bitmap is not the
    /// same statement as "this fragment cannot be typeset". They do *not* enter
    /// `deferred`: nothing here is competing for the same bytes, so every one
    /// of them is free to come back.
    ///
    /// It comes back later than a figure or a picture does, and that is this
    /// store's shape rather than a choice made here. `artifact(for:)` is a pure
    /// read — it is called for every element in the scene while the layer view
    /// culls, not only the visible ones, so scheduling from it would typeset a
    /// whole board's notation and undo the purge. The retry point is therefore
    /// `prepare(scene:)`, and the learner's notation returns with the tutor's
    /// next board update.
    private func purgeUnderMemoryPressure() {
        completed.subtract(artifacts.keys)
        artifacts.removeAll()
        order.removeAll()
        totalBytes = 0
    }

    /// The whole of the engine contact.
    ///
    /// Fails closed on what the builder *rejects* — an unterminated group
    /// (`mismatchBraces`) or an unknown command (`invalidCommand`) — and on a
    /// fragment that typesets to nothing: no artifact at all, rather than an
    /// empty tile the model would read back as drawn.
    ///
    /// That is the whole of the guarantee, and it is narrower than "malformed
    /// LaTeX". The builder has no missing-argument error kind, so `\frac{1}`
    /// parses as `\frac{1}{}` and typesets a fraction bar over an empty
    /// denominator. Notation that is merely wrong still reaches the board; only
    /// notation the parser refuses is held back.
    private static func typeset(latex: String, fontSize: CGFloat, color: UIColor) -> MathArtifact? {
        let body = typesettableLatex(latex)
        guard !body.isEmpty else { return nil }
        // Capture the scale in one local: the artifact keeps what it was drawn
        // at, and `drawSize` divides by that captured value, so geometry does
        // not move if the trait environment changes after the typeset.
        let oversample = rasterOversample
        let math = MTMathImage(
            latex: body,
            fontSize: max(1, fontSize) * oversample,
            textColor: color,
            labelMode: .display,
            textAlignment: .left
        )
        let (error, image) = math.asImage()
        guard error == nil,
              let image,
              image.size.width > 0,
              image.size.height > 0,
              let cgImage = image.cgImage
        else { return nil }
        return MathArtifact(image: cgImage, size: image.size, oversample: oversample)
    }
}
