/** Explicit soft wrapping: preserve source order, words where possible and complete graphemes. */
export function wrapParagraph(text: string, width: number, measure: (text: string) => number): string {
  const words = new Intl.Segmenter(undefined, { granularity: 'word' });
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return text.replace(/\t/g, '        ').split('\n').map(paragraph => {
    const lines: string[] = []; let line = '';
    const add = (part: string) => {
      if (line && measure(line + part) > width) { lines.push(line); line = ''; }
      line += part;
    };
    for (const { segment } of words.segment(paragraph)) {
      if (measure(segment) <= width) add(segment);
      else for (const { segment: grapheme } of graphemes.segment(segment)) add(grapheme);
    }
    lines.push(line); return lines.join('\n');
  }).join('\n');
}
