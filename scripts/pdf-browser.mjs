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
    build.onLoad({ filter: /pdfjs-dist[\\/]+build[\\/]+pdf\.mjs$/ }, async ({ path }) => {
      let contents = await readFile(path, 'utf8');
      const source = 'process.getBuiltinModule(';
      const fsCount = contents.split('process.getBuiltinModule("fs")').length - 1;
      const count = contents.split(source).length - 1;
      if (fsCount !== 3 || count !== 7) throw Error(`PDF.js Node builtin reader structure changed: expected 3 fs and 7 total, got ${fsCount} fs and ${count} total`);
      contents = contents.replaceAll(source, '((name) => { throw new Error(`PageInk PDF viewer does not load Node builtin ${name}.`); })(');
      return { contents, loader: 'js' };
    });
  },
};
