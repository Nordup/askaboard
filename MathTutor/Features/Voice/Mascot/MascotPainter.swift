import CoreGraphics
import SwiftUI

/// Draws one `MascotMotion.Frame` into a `GraphicsContext`.
///
/// A handful of gradient fills and stroked ellipses — no filters, no offscreen images —
/// which is what keeps a 30 fps Canvas cheap for the length of a call. The colours are
/// `OrbPalette`'s: the boards reuse the orb's oklab stops verbatim for the mascot, so the
/// painter reuses the Swift constants rather than converting the same stops twice.
///
/// Stacking, from the boards: halo (core below or above the blooms, per size), then the
/// thinking ring / talking ripples / orbiting dot, then the face and eyes on top.
enum MascotPainter {

    static func draw(
        _ frame: MascotMotion.Frame,
        metrics: MascotMetrics,
        in context: inout GraphicsContext,
        canvasSize: CGSize
    ) {
        // The Canvas is centred on the face centre; the halo's few points of float are
        // baked into the metrics' offsets.
        let faceCentre = CGPoint(x: canvasSize.width / 2, y: canvasSize.height / 2)
        let s = metrics.stateScale

        drawHalo(frame, metrics: metrics, faceCentre: faceCentre, in: &context)
        drawAccents(frame, faceCentre: faceCentre, scale: s, in: &context)
        drawFace(frame, metrics: metrics, faceCentre: faceCentre, scale: s, in: &context)
    }

    // MARK: - Halo

    private static func drawHalo(
        _ frame: MascotMotion.Frame,
        metrics: MascotMetrics,
        faceCentre: CGPoint,
        in context: inout GraphicsContext
    ) {
        guard frame.haloOpacity > 0.003 else { return }

        // note/27 fades the halo as one layer, so the blooms are composited first and the
        // state opacity is applied once — fading each gradient separately would darken
        // their overlap differently at every opacity.
        var halo = context
        halo.opacity = frame.haloOpacity
        halo.drawLayer { layer in
            let bloomBox = CGRect(
                centre: CGPoint(
                    x: faceCentre.x + metrics.bloomCentreOffset.width,
                    y: faceCentre.y + metrics.bloomCentreOffset.height
                ),
                size: CGSize(
                    width: metrics.bloomBox.width * frame.haloScale,
                    height: metrics.bloomBox.height * frame.haloScale
                )
            )

            if !metrics.core.paintsAboveBlooms {
                drawCore(frame, metrics: metrics, faceCentre: faceCentre, in: &layer)
            }

            // CSS paints its first background layer on top: cool below, warm above.
            fillEllipticalGradient(
                &layer,
                stops: OrbPalette.coolBloomStops(frame.coolAlphas),
                centre: bloomBox.point(atFraction: CGPoint(x: 0.64, y: 0.58)),
                semiAxes: CGSize(width: 0.46 * bloomBox.width, height: 0.44 * bloomBox.height)
            )
            fillEllipticalGradient(
                &layer,
                stops: OrbPalette.warmBloomStops(frame.warmAlphas),
                centre: bloomBox.point(atFraction: CGPoint(x: 0.38, y: 0.40)),
                semiAxes: CGSize(width: 0.46 * bloomBox.width, height: 0.44 * bloomBox.height)
            )

            if metrics.core.paintsAboveBlooms {
                drawCore(frame, metrics: metrics, faceCentre: faceCentre, in: &layer)
            }
        }
    }

    private static func drawCore(
        _ frame: MascotMotion.Frame,
        metrics: MascotMetrics,
        faceCentre: CGPoint,
        in context: inout GraphicsContext
    ) {
        guard frame.coreOpacity > 0.003 else { return }
        let core = metrics.core
        let box = CGRect(
            centre: CGPoint(
                x: faceCentre.x + core.centreOffset.width,
                y: faceCentre.y + core.centreOffset.height
            ),
            size: CGSize(
                width: core.box.width * frame.coreScale,
                height: core.box.height * frame.coreScale
            )
        )
        var layer = context
        layer.opacity = frame.coreOpacity
        fillEllipticalGradient(
            &layer,
            stops: coreStops(core.stops),
            centre: box.point(atFraction: core.centreFraction),
            semiAxes: CGSize(
                width: core.radiusFraction.width * box.width,
                height: core.radiusFraction.height * box.height
            )
        )
    }

    private static func coreStops(_ variant: MascotCoreStops) -> [Gradient.Stop] {
        switch variant {
        case .hero:
            return OrbPalette.coreStops
        case .inner:
            // Board 28's separate inner layer: full at 0, 70 % at 55 %, gone at 100 %.
            return [
                Gradient.Stop(color: OrbPalette.coreStart, location: 0),
                Gradient.Stop(color: OrbPalette.coreEnd.opacity(0.7), location: 0.55),
                Gradient.Stop(color: OrbPalette.coreEnd.opacity(0), location: 1),
            ]
        }
    }

    // MARK: - State accents

    private static func drawAccents(
        _ frame: MascotMotion.Frame,
        faceCentre: CGPoint,
        scale s: CGFloat,
        in context: inout GraphicsContext
    ) {
        // All three accents are centred on the face centre on the note — only the dot
        // stands off, on its orbit.
        if let ring = frame.ring, ring.opacity > 0.003 {
            let diameter = ring.diameter * s
            context.stroke(
                Path(ellipseIn: CGRect(centre: faceCentre, size: CGSize(width: diameter, height: diameter))),
                with: .color(DS.Color.brand.opacity(ring.opacity)),
                lineWidth: MascotSpec.ringStrokeWidth * s
            )
        }

        for ripple in frame.ripples where ripple.opacity > 0.003 {
            let diameter = ripple.diameter * s
            context.stroke(
                Path(ellipseIn: CGRect(centre: faceCentre, size: CGSize(width: diameter, height: diameter))),
                with: .color(DS.Color.brand.opacity(ripple.opacity)),
                lineWidth: MascotSpec.rippleStrokeWidth * s
            )
        }

        if let dot = frame.orbitDot, dot.opacity > 0.003 {
            let centre = CGPoint(
                x: faceCentre.x + MascotSpec.dotOrbitRadius * s * CGFloat(cos(dot.angle)),
                y: faceCentre.y + MascotSpec.dotOrbitRadius * s * CGFloat(sin(dot.angle))
            )
            let diameter = MascotSpec.dotDiameter * s
            context.fill(
                Path(ellipseIn: CGRect(centre: centre, size: CGSize(width: diameter, height: diameter))),
                with: .color(DS.Color.brand.opacity(dot.opacity))
            )
        }
    }

    // MARK: - Face

    private static func drawFace(
        _ frame: MascotMotion.Frame,
        metrics: MascotMetrics,
        faceCentre: CGPoint,
        scale s: CGFloat,
        in context: inout GraphicsContext
    ) {
        let bob = frame.faceBobFraction * metrics.face.height
        let faceRect = CGRect(
            centre: CGPoint(x: faceCentre.x, y: faceCentre.y + bob),
            size: metrics.face
        )

        // The capsule body, on the orb's own vertical oklab gradient.
        let bodyStops = [
            Gradient.Stop(color: OrbPalette.bodyTop, location: 0),
            Gradient.Stop(color: OrbPalette.bodyMid, location: 0.46),
            Gradient.Stop(color: OrbPalette.bodyBottom, location: 1),
        ]
        context.fill(
            Path(roundedRect: faceRect, cornerRadius: min(faceRect.width, faceRect.height) / 2),
            with: .linearGradient(
                Gradient(stops: bodyStops),
                startPoint: CGPoint(x: faceRect.midX, y: faceRect.minY),
                endPoint: CGPoint(x: faceRect.midX, y: faceRect.maxY)
            )
        )

        // Eyes: the base row sits on the size's own centre line; the state moves it in
        // reference units. Circles at rest, capsules while talking.
        let eyeSize = CGSize(width: frame.eyeSize.width * s, height: frame.eyeSize.height * s)
        let eyeY = faceRect.minY + metrics.eyeCentreY + frame.eyeOffset.dy * s
        let halfSpread = frame.eyeCentreDistance * s / 2
        for side: CGFloat in [-1, 1] {
            let centre = CGPoint(
                x: faceRect.midX + frame.eyeOffset.dx * s + side * halfSpread,
                y: eyeY
            )
            context.fill(
                Path(
                    roundedRect: CGRect(centre: centre, size: eyeSize),
                    cornerRadius: min(eyeSize.width, eyeSize.height) / 2
                ),
                with: .color(DS.Color.surface)
            )
        }
    }

    // MARK: - Elliptical gradients

    /// One `radial-gradient(ellipse rx ry at cx cy …)`: a circular radial gradient of
    /// radius `rx`, drawn through a y-scale of `ry / rx` — the Canvas twin of the trick
    /// `OrbHalo` plays with `EllipticalGradient` frames.
    private static func fillEllipticalGradient(
        _ context: inout GraphicsContext,
        stops: [Gradient.Stop],
        centre: CGPoint,
        semiAxes: CGSize
    ) {
        guard semiAxes.width > 0, semiAxes.height > 0 else { return }
        var layer = context
        layer.translateBy(x: centre.x, y: centre.y)
        layer.scaleBy(x: 1, y: semiAxes.height / semiAxes.width)
        let r = semiAxes.width
        layer.fill(
            Path(CGRect(x: -r, y: -r, width: 2 * r, height: 2 * r)),
            with: .radialGradient(
                Gradient(stops: stops),
                center: .zero,
                startRadius: 0,
                endRadius: r
            )
        )
    }
}

private extension CGRect {
    init(centre: CGPoint, size: CGSize) {
        self.init(
            x: centre.x - size.width / 2,
            y: centre.y - size.height / 2,
            width: size.width,
            height: size.height
        )
    }

    func point(atFraction fraction: CGPoint) -> CGPoint {
        CGPoint(x: minX + fraction.x * width, y: minY + fraction.y * height)
    }
}
