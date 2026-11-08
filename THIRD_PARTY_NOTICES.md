# Third-party notices

Askaboard is open source under the [MIT License](LICENSE). It is built on the
open-source work below. Each part keeps its own license and copyright.

## In the app

| Software | License | Copyright |
| --- | --- | --- |
| [Electron](https://github.com/electron/electron) (with Chromium and Node.js) | MIT | © Electron contributors; © 2013-2020 GitHub Inc. |
| [React](https://github.com/facebook/react) and React DOM | MIT | © Meta Platforms, Inc. and affiliates |
| [three.js](https://github.com/mrdoob/three.js) | MIT | © 2010-2026 three.js authors |
| [KaTeX](https://github.com/KaTeX/KaTeX), code and fonts | MIT | © 2013-2020 Khan Academy and other contributors |
| [DOMPurify](https://github.com/cure53/DOMPurify) | Apache-2.0 (chosen from MPL-2.0 or Apache-2.0) | Cure53 and contributors |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | MIT | © 2024 Anthropic, PBC |
| [Acorn](https://github.com/acornjs/acorn) | MIT | © 2012-2022 by various contributors |
| [Zod](https://github.com/colinhacks/zod) | MIT | © 2025 Colin McDonnell |
| [Lucide](https://github.com/lucide-icons/lucide) icons | ISC | © 2026 Lucide Icons and Contributors |

The app also contains the packages that these depend on. The full license
text of every package is inside the app, in its `node_modules` folder.
Chromium's licenses are in `LICENSES.chromium.html`, also inside the app.

The handwriting font is made from the Hershey fonts, which are in the public
domain.

## Code adapted from other projects

The usage-data code (`space/src/main/analytics.ts` and
`space/src/main/analytics-id.ts`) follows the telemetry design of
[T3 Code](https://github.com/pingdotgg/t3code). MIT License,
© 2026 T3 Tools Inc.

## Downloaded only when you turn on the local voice

These are not part of the app. When you install the local voice in
Settings, the app downloads them from the sherpa-onnx releases on GitHub and
runs them as a separate program.

| Software | License |
| --- | --- |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | Apache-2.0 |
| [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) voice model | Apache-2.0 |
| [espeak-ng](https://github.com/espeak-ng/espeak-ng), inside the sherpa-onnx program | GPL-3.0 |

## License texts

### MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### ISC License

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

### Apache License 2.0

The full text is at <https://www.apache.org/licenses/LICENSE-2.0> and in the
app at `node_modules/dompurify/LICENSE`.
