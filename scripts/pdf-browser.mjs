import { readFile } from 'node:fs/promises';

/** PDFKit's browser bundle still includes string-path readers. PageInk only supplies bytes. */
export const pdfBrowserOnly = {
  name: 'pageink-pdf-browser-only',
  setup(build) {
    build.onLoad({ filter: /pdfkit\.standalone\.js$/ }, async ({ path }) => {
      let contents = await readFile(path, 'utf8');
      const source = "require('fs')";
      const count = contents.split(source).length - 1;
      if (count !== 3) throw Error(`PDFKit filesystem reader structure changed: expected 3, got ${count}`);
      contents = contents.replaceAll(source, "({ readFileSync() { throw new Error('PageInk PDF export accepts in-memory bytes, not filesystem paths.'); } })");
      return { contents, loader: 'js' };
    });
  },
};
