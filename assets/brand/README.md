# Askaboard brand assets

Use the full-color sweep as the main mark. The source is [mark.svg](mark.svg).
The [wordmark outlines](wordmark.svg) use Source Sans 3 Semibold. See the
[font license](SourceSans3-LICENSE.txt). The live website
uses its own interface font for the header label.

| Where | File | Format and size |
| --- | --- | --- |
| Website header, docs, slides, or print | [Mark source](mark.svg), [light-text lockup](exports/logo/lockup-light-text.svg), [dark-text lockup](exports/logo/lockup-dark-text.svg) | Scalable SVG. Both lockups also have 1224 × 246 transparent PNGs. |
| Artwork and profile images | [Logo exports](exports/logo/) | Square PNGs at 16, 32, 64, 128, 256, 512 and 1024 px, with either alpha or an opaque dark field. Black and white variants have SVG and 512 px transparent PNGs. |
| Mac Dock, Finder and release packaging | [Packaging PNG](../../space/resources/icon.png), [Mac icon source](exports/mac/Askaboard.svg), [ICNS](exports/mac/Askaboard.icns) | 1024 × 1024 PNG with transparent outer padding. ICNS contains Apple’s 16, 32, 128, 256 and 512 pt representations at 1× and 2×. Electron Builder uses the packaging PNG. |
| Future macOS status item | [Template](exports/mac/AskaboardTemplate.svg), [1× PNG](exports/mac/AskaboardTemplate.png), [2× PNG](exports/mac/AskaboardTemplate@2x.png) | Black and alpha. The 16 and 32 px PNGs share the Electron template basename and let macOS tint the mark. |
| Website tab and Apple home screen | [SVG favicon](../../apps/website/app/icon.svg), [ICO fallback](exports/web/favicon.ico), [Apple touch icon](../../apps/website/public/apple-touch-icon.png) | 32 px SVG, 16/32/48 px ICO, 180 px opaque touch PNG. The website serves the SVG and touch icon. |
| Website links and social posts | [Website share card](../../apps/website/public/askaboard-social.png) | 1200 × 630 PNG, cut from the README hero image by `space/scripts/readme/hero-image.mjs`. Set `ASKABOARD_SITE_URL` to the public HTTPS origin at build time to enable absolute Open Graph and Twitter image URLs. |
| GitHub repository share preview | [GitHub card](exports/web/github-social.png) | 1280 × 640 PNG, under 1 MB, cut from the README hero image by `space/scripts/readme/hero-image.mjs`. Upload through repository Settings when the public repo is ready. |

To change the mark, edit the source SVG, then regenerate on macOS with Node
and the website dependencies installed:

```sh
node assets/askaboard/export.mjs
```

The exporter uses the website's existing Sharp dependency and macOS
`iconutil`. Commit source changes with their matching exports. The generated
brand assets are ready for use. The Mac app has no status item today. The
first public Mac release still needs its app identity, version, signed and
notarized DMG, and a clean-Mac install check. The website still follows the
local-only deployment rule in [AGENTS.md](../../AGENTS.md).

Release references: [Apple app icons](https://developer.apple.com/design/human-interface-guidelines/app-icons),
[Apple iconsets](https://developer.apple.com/library/archive/documentation/GraphicsAnimation/Conceptual/HighResolutionOSX/Optimizing/Optimizing.html),
[Electron Builder icons](https://www.electron.build/v26/docs/features/icons-and-images/),
[Electron tray templates](https://www.electronjs.org/docs/latest/api/native-image),
[Next.js icons](https://nextjs.org/docs/app/api-reference/file-conventions/metadata/app-icons),
[Next.js metadata](https://nextjs.org/docs/app/api-reference/functions/generate-metadata),
and [GitHub repository previews](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview).

The README hero image, [readme/hero.png](readme/hero.png), is the real app window
(2560 × 1440): the website hero drawn on a board, with a Claude Code window in
front. To make it again on macOS (it starts its own app instance and stops it after):

```sh
cd space && node scripts/readme/hero-image.mjs
```
