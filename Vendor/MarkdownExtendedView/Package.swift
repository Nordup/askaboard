// swift-tools-version: 5.9
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
    name: "MarkdownExtendedView",
    platforms: [
        .iOS(.v16),
        .macOS(.v13)
    ],
    products: [
        .library(
            name: "MarkdownExtendedView",
            targets: ["MarkdownExtendedView"]
        ),
    ],
    dependencies: [
        // Apple's official Markdown parser (CommonMark + GFM extensions)
        .package(url: "https://github.com/apple/swift-markdown.git", from: "0.4.0"),
        // Extended LaTeX rendering for SwiftUI (fork of SwiftMath with additional symbol
        // coverage). Vendored from the 2.1.3 tag so the tutor can carry its own commands
        // on top — \boxed lives only in this copy, not upstream.
        .package(path: "../ExtendedSwiftMath"),
    ],
    targets: [
        .target(
            name: "MarkdownExtendedView",
            dependencies: [
                .product(name: "Markdown", package: "swift-markdown"),
                .product(name: "ExtendedSwiftMath", package: "ExtendedSwiftMath"),
            ]
        ),
    ]
)
