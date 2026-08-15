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
/// `size` is the raster's own size in points, taken at
/// `BoardMathStore.rasterOversample` times the element's font size; `drawSize`
/// is what it occupies on the board. Everything that places notation uses
/// `drawSize`, so the oversampling factor lives in exactly one place.
@MainActor
struct MathArtifact {
    let image: CGImage
    let size: CGSize

    /// The notation's size in board points.
    var drawSize: CGSize {
        CGSize(
            width: size.width / BoardMathStore.rasterOversample,
            height: size.height / BoardMathStore.rasterOversample
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
    /// learner pinches; typesetting at twice the size costs four times the
    /// pixels of a small label and nothing that matters.
    static let rasterOversample: CGFloat = 2

    private var artifacts: [String: MathArtifact] = [:]
    private var completed: Set<String> = []
    private var inFlight: [String: Task<MathArtifact?, Never>] = [:]

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
        for element in scene.elements {
            if case .mathText(let math) = element {
                prepare(mathElement: math)
            }
        }
    }

    func prepare(mathElement element: MathTextElement) {
        let key = Self.cacheKey(for: element)
        guard !completed.contains(key), inFlight[key] == nil else { return }
        schedule(element: element, key: key)
    }

    func artifact(for element: MathTextElement) -> MathArtifact? {
        artifacts[Self.cacheKey(for: element)]
    }

    /// Typesets (or awaits an in-flight typeset) and returns the ready
    /// artifact. Used by tests and capture paths that need the notation
    /// composited rather than merely scheduled.
    @discardableResult
    func render(element: MathTextElement) async -> MathArtifact? {
        let key = Self.cacheKey(for: element)
        if let artifact = artifacts[key] { return artifact }
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
                self.artifacts[key] = artifact
            }
            NotificationCenter.default.post(name: .boardSceneArtifactReady, object: nil)
            return artifact
        }
        inFlight[key] = task
        return task
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
        let math = MTMathImage(
            latex: body,
            fontSize: max(1, fontSize) * rasterOversample,
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
        return MathArtifact(image: cgImage, size: image.size)
    }
}
