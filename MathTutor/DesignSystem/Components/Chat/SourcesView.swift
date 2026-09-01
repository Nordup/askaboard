import Foundation
import SwiftUI

extension TutorSource {
    /// The source as a link target, or `nil` when the server's `url` is not a
    /// valid absolute URL. A malformed row still renders its title and domain;
    /// only the link is withheld.
    var destinationURL: URL? {
        guard let url = URL(string: url),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https"
        else { return nil }
        return url
    }

    /// A compact display domain for a source card. Falls back to the URL's
    /// host, then to the raw string when the host is empty — a server may
    /// send a search-engine result whose `url` field is not parseable.
    var displayDomain: String {
        guard let host = destinationURL?.host, !host.isEmpty else { return url }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }
}

/// The compact source line used inside an expanded search operation. It stays
/// in the same icon and text columns as every operation row — no nested inset,
/// card, snippet, or second vertical hierarchy.
struct TrailSourceRow: View {
    @Environment(\.openURL) private var openURL

    let source: TutorSource
    var diagnosticID: String? = nil
    var isAccessibilityHidden = false
    static let rowHeight: CGFloat = 30

    var body: some View {
        row
            .onTapGesture {
                if let url = source.destinationURL {
                    openURL(url)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(
                isAccessibilityHidden ? "" : SourcesView.cardLabel(for: source)
            )
            .accessibilityHint(source.destinationURL == nil ? "" : "Opens this source in your browser")
            .accessibilityAddTraits(source.destinationURL == nil ? [] : .isLink)
            .accessibilityHidden(isAccessibilityHidden)
            .background {
                if let diagnosticID {
                    ActivityLayoutFrameMarker(id: diagnosticID)
                }
            }
    }

    private var row: some View {
        HStack(spacing: 9) {
            ZStack {
                Circle().fill(DS.Color.surfaceBubble)
                Text(monogram)
                    .textStyle(.label)
                    .foregroundStyle(DS.Color.inkSecondary)
            }
            .frame(width: 20, height: 20)
            HStack(spacing: DS.Space.s2) {
                Text(source.title)
                    .textStyle(.trailLabel)
                    .foregroundStyle(DS.Color.ink)
                    .lineLimit(1)
                Text(source.displayDomain)
                    .textStyle(.trailReasoning)
                    .foregroundStyle(DS.Color.inkTertiary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .frame(height: Self.rowHeight)
        .contentShape(Rectangle())
    }

    private var monogram: String {
        let seed = source.displayDomain.first ?? source.title.first
        return seed.map { String($0).uppercased() } ?? "•"
    }
}

/// ChatGPT-style source rows for a tutor message.
///
/// The section sits beneath the tutor's prose, opens real links with SwiftUI's
/// `Link`/`OpenURL` machinery, and never renders provider HTML or a WebView.
/// Sources are plain domain objects carried on `TutorMessage`; this view only
/// draws them.
struct SourcesView: View {
    let sources: [TutorSource]
    /// The column this draws in, like `MessageMetrics.rowWidth`.
    var width: CGFloat = DS.Container.panelContent

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.s2) {
            Text("Sources")
                .textStyle(.trailLabel)
                .foregroundStyle(DS.Color.inkSecondary)
            ForEach(sources) { source in
                SourceCard(source: source)
            }
        }
        .frame(width: width, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Self.sectionLabel(count: sources.count))
    }

    static func sectionLabel(count: Int) -> String {
        switch count {
        case 1: "1 source"
        default: "\(count) sources"
        }
    }

    /// A deterministic label for one row, used by the card and assertable in
    /// tests without rendering a view tree.
    static func cardLabel(for source: TutorSource) -> String {
        "\(source.title), \(source.displayDomain)"
    }
}

/// One source row: a soft card with the design's small glyph, title, domain,
/// and an optional snippet. `Link` keeps the row native (no WebView) and
/// exposes the URL through the system's open-URL mechanism.
struct SourceCard: View {
    let source: TutorSource

    var body: some View {
        content
            .background(DS.Color.surfaceBubble, in: RoundedRectangle(cornerRadius: DS.Radius.xs, style: .circular))
            .contentShape(RoundedRectangle(cornerRadius: DS.Radius.xs, style: .circular))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(SourcesView.cardLabel(for: source))
            .accessibilityHint("Opens this source in your browser")
            .accessibilityAddTraits(source.destinationURL == nil ? [] : .isLink)
    }

    @ViewBuilder
    private var content: some View {
        if let url = source.destinationURL {
            Link(destination: url) {
                row
            }
            .buttonStyle(.plain)
        } else {
            row
        }
    }

    private var row: some View {
        HStack(alignment: .top, spacing: DS.Space.s2) {
            IconView(.trailSearch, size: 14, tint: DS.Color.inkTertiary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: DS.Space.s1) {
                Text(source.title)
                    .textStyle(.trailLabel)
                    .foregroundStyle(DS.Color.ink)
                    .multilineTextAlignment(.leading)
                Text(source.displayDomain)
                    .textStyle(.trailReasoning)
                    .foregroundStyle(DS.Color.inkSecondary)
                    .multilineTextAlignment(.leading)
                if let snippet = source.snippet, !snippet.isEmpty {
                    Text(snippet)
                        .textStyle(.trailReasoning)
                        .foregroundStyle(DS.Color.inkSecondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(DS.Space.s3)
    }
}
