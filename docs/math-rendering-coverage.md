# Math rendering coverage audit

*2026-08-15. Audited and extended in response to a tutor reply whose `\boxed`
formula rendered as a blank band on the iPad.*

## The question and the method

The tutor model can emit any LaTeX — there is no schema in the OpenAI docs
that constrains it. Two evidence sources stand in for one:

1. **KaTeX is the de facto spec.** ChatGPT renders model output with KaTeX,
   and models are in practice tuned to produce KaTeX-renderable markup. The
   [KaTeX supported-functions table](https://katex.org/docs/supported.html)
   (926 command names) and its `symbols.ts` source (exact command → Unicode →
   atom-class mapping) define the target.
2. **The recorder is ground truth for actual output.** The backend records
   every turn. All emitted formulas were extracted from `messages` +
   `llm_calls.response` and parsed against the app's renderer.

The renderer is `Vendor/ExtendedSwiftMath` (vendored 2026-08-15 from the
upstream 2.1.3 tag; `Vendor/MarkdownExtendedView` depends on it by path).

## Why a gap matters

A parse failure does not degrade — it erases. `MTMathUILabel` sets its math
list to nil, the SwiftUI wrapper's size guard returns nil, and the formula
displays as an empty band (`MTMathUILabel.swift` error path,
`LaTeXView.swift` `sizeThatFits`). One unknown command blanks the whole
formula. A visible raw-TeX fallback is proposed as a separate task and is
still worth doing as insurance.

## Results

| Probe | Before | After |
| --- | --- | --- |
| Formulas ever emitted by the tutor (recorder DB) | 52 of 53 parsed (`\boxed` failed) | 53 of 53 |
| KaTeX command names (926 probed) | 529 failed | 92 fail |
| Common display environments (23 probed) | 10 parsed | 22 parse (all but `CD`) |

Regression suites: `BoxedTests.swift`, `KatexCoverageTests.swift` in
`Vendor/ExtendedSwiftMath/Tests/`. The full package suite passes and the app
builds.

## What was added

- **`\boxed{...}`** — new `MTBoxed` atom and `MTBoxedDisplay` frame at TeX's
  `\fboxsep`/`\fboxrule` metrics.
- **~200 symbols generated from KaTeX `symbols.ts`** — AMS relations
  (`\therefore`, `\lesssim`, `\rightleftharpoons`, harpoons, negated arrows),
  binary operators, delimiters (`\lVert`, `\lparen`, `\llbracket`), misc
  (`\checkmark`, `\blacksquare`, suits, `\textdegree`, text escapes).
- **Curated symbols** — Greek capital lookalikes (`\Alpha`…`\Chi`), number
  sets (`\Reals`, `\Complex`, `\natnums`), the colon-assignment family
  (`\coloneqq`, `\eqqcolon`, `\dblcolon`, …), closest-form negated relations
  (`\ngeqq` → ≱ class), `\lBrace`, `\minuso`, corners, moustaches.
- **Operators** — `\argmax`, `\argmin`, `\plim`, `\injlim`, `\projlim`,
  European trig names (`\tg`, `\ctg`, `\sh`, `\ch`, `\cosec`, …), `\intop`,
  `\smallint`, `\oiint`, `\oiiint`.
- **~60 aliases** — `\dots` family, `\isin`, `\larr`/`\rArr` arrow shorthands,
  `\infin`, `\plusmn`, `\varGamma` → `\Gamma`, `\varliminf` → `\liminf`,
  `\impliedby`, suit shorthands, `\weierp`, `\real`, `\image`.
- **Font styles** — `\bold`, `\pmb`, `\Bbb`, `\it`, `\sf`, `\tt`, `\emph`,
  `\mathscr` (mapped to calligraphic), `\textnormal`/`\textmd`/`\textup`.
- **Spacing** — `\thinspace`/`\medspace`/`\thickspace` and negatives,
  `\enspace`, `\space`, `\nobreakspace`, and dimension commands `\kern`,
  `\mkern`, `\mskip`, `\hskip`, `\hspace` (braced or bare, mu/pt/em/ex).
- **Structural** — `\dbinom`/`\tbinom`; `\sout` (horizontal strike, a new
  `MTCancel` case); `\phantom`/`\hphantom`/`\vphantom`/`\smash` (new
  `MTPhantom` atom: reserve space without drawing, or draw without height);
  `\tag`, `\notag`, `\nonumber` and text-size switches as safe no-ops;
  `\mathop`/`\mathbin`/`\mathrel`/… spacing reclassification; `\Bra`/`\Ket`/
  `\Braket`/`\set`/`\Set`; `\fcolorbox` (border color dropped);
  `\operatornamewithlimits`; `\llap`/`\rlap`/`\clap`; `\underbar`.
- **x-arrow family** — `\xmapsto`, `\xhookrightarrow`, `\xLeftarrow`,
  `\xlongequal`, harpoon and twohead variants (16 commands), reusing the
  existing stretchy-arrow machinery.
- **`\overbrace`/`\underbrace`/`\overbracket`/`\underbracket`** — brace glyph
  stretched to the content width (glyph variants, then horizontal scaling),
  with `^`/`_` labels folded into the limit position above/below the brace.
- **Accents** — `\mathring`, `\widecheck`, `\dddot`, `\ddddot`,
  `\overleftharpoon`, `\overrightharpoon`, `\overgroup`.
- **Environments** — `array`/`subarray` with `{l|cr}` column specs (`|` rules
  ignored), `align`/`align*`/`alignedat{n}` (as `aligned`), `gather*`/
  `gathered`/`equation`/`equation*` (single column, centered), `dcases`
  (display-style cells), `rcases` (right brace). Already supported upstream:
  matrix family, `cases`, `aligned`, `split`, `gather`, `eqnarray` (3-col).

## Known degradations (parse fine, render approximately)

- `\varGamma`-style italic capitals render upright (aliased to `\Gamma`).
- `\ngeqq`, `\nleqq`, `\nsubseteqq`, `\nsupseteqq`, `\gvertneqq`, `\lvertneqq`
  use the closest single codepoint, not the exact combining form.
- Rare colon ligatures (`\Colonapprox` …) are composed character sequences.
- `\tag{...}` labels are parsed and dropped (no equation-number gutter).
- Text-size switches (`\small` … `\Huge`) and `\mathstrut` are no-ops.
- `\mathop{...}` with a complex (non-plain-text) argument falls back to
  ordinary spacing.
- `array` column separators (`|`) do not draw rules.
- `\eqcolon` uses ∹ (U+2239); KaTeX draws −: as a ligature.

## Still missing, by design

92 of 926 probe names still fail. Categories, with assessment:

- **Probe artifacts (actually supported)** — `\left`/`\right`/`\middle`,
  `\big` family, `\begin`/`\end`, `\limits`/`\nolimits`, `\genfrac`,
  `\kern`-family (the probe passes `{x}` instead of a dimension), `\hline` in
  tables, `\pod`. No action needed.
- **TeX macro system** — `\def`, `\newcommand`, `\let`, `\global`, `\edef`,
  `\expandafter`, `\relax`, … Real work to support; models emit these in
  chat math roughly never. If one appears, the formula blanks — the raw-TeX
  fallback task is the mitigation, not implementation.
- **HTML/graphics embeds** — `\href`, `\url`, `\includegraphics`,
  `\htmlClass` family, `\verb`. Not meaningful in the app; deliberately out.
- **Table internals** — `\cline`, `\multicolumn`, `\hdashline`,
  `\arraystretch`, `\newline`. Rare in model output; revisit only if the
  recorder shows them.
- **Niche typography** — `\not` (combining negation), `\Overrightarrow`,
  under-arrows (`\underrightarrow`, `\undergroup`, `\utilde`,
  `\overlinesegment`), `\phase`, `\textcircled`, actuarial `\angl`,
  `\raisebox`, `\rule`, `\hbox`, `\vcenter`, `\mathchoice`, logos
  (`\KaTeX`, `\LaTeX`, `\TeX`), `CD` environment. Low value per effort;
  most have supported spellings the model prefers (`\neq`, `\vec`).

## Re-running the audit

1. Harvest emitted formulas: query `messages` (role `assistant`) and
   `llm_calls.response->>'text'`, extract `\( \)` / `\[ \]` spans.
2. Extract command names from the KaTeX supported page; probe each through
   `MTMathListBuilder.build` with 0–3 braced arguments (context-dependent
   commands need hand checks — see probe artifacts above).
3. For new gaps, take glyph and atom class from KaTeX `symbols.ts`; commands
   whose glyph is a plain source character must go into
   `MTMathAtomFactory.excludedFromReverseMapping`, or serialization rewrites
   ordinary characters as commands ("A" → `\Alpha`).

## Related

- Follow-up task (pending chip): visible raw-TeX fallback when a formula
  still fails to parse, so unknown commands degrade instead of vanishing.
- `Vendor/ExtendedSwiftMath/README.md` carries the vendored-copy change log.
