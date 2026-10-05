import { describe, expect, it } from 'vitest';
import { adaptLatexDelimiters } from './MessageView';

describe('adaptLatexDelimiters', () => {
  it('maps tutor bracket math to remark-math without changing code delimiters', () => {
    const source = String.raw`Inline: \(x^2\)

\[
\frac{1}{2}
\]

Code: ` + '`' + String.raw`\(keep\)` + '`' + String.raw`

` + '```text\n' + String.raw`\[keep this too\]` + '\n```';
    const rendered = adaptLatexDelimiters(source);
    expect(rendered).toContain('$x^2$');
    expect(rendered).toContain(String.raw`$$
\frac{1}{2}
$$`);
    expect(rendered).toContain('`\\(keep\\)`');
    expect(rendered).toContain('```text\n\\[keep this too\\]\n```');
    expect(adaptLatexDelimiters('```\n\\(unclosed code\\)')).toContain('\\(unclosed code\\)');
  });
});
