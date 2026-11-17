# PDF runtime assets

PageInk embeds decoder binaries from `pdfjs-dist@5.4.624`, fixed by `package-lock.json`. `EmbeddedWasm` in `src/assets.ts` supplies them to PDF.js; `AssetStore` decompresses and checks byte lengths. PDF content is decoded locally.

| Asset | Purpose | License | SHA-256 |
| --- | --- | --- | --- |
| `jbig2.wasm` | PDFium JBIG2 decoder | BSD-3-Clause + Apache-2.0 wrapper | `df85117444f0f0150c5c9d0dd8eeab102d705217f838a9f6d46788b6d9b3d681` |
| `openjpeg.wasm` | OpenJPEG JPEG 2000 decoder | BSD-2-Clause + Apache-2.0 wrapper | `67b8e2b162da472e98cb48d3d32e3e38fff481b9b32ff4818e78bb248af88ab2` |
| `qcms_bg.wasm` | qcms ICC color conversion | MIT + Apache-2.0 wrapper | `6017eca5939cde1836e88e6d8cd27ae039246f206515ea4487bdfd0e3fb16e26` |

## Source and notices

Package source: [pdfjs-dist](https://github.com/mozilla/pdfjs-dist) and [PDF.js](https://github.com/mozilla/pdf.js). Binaries and notices are copied from the npm package without recompilation.

| Decoder | Original notice | PDF.js wrapper notice |
| --- | --- | --- |
| JBIG2 | `LICENSE_JBIG2` | `LICENSE_PDFJS_JBIG2` |
| OpenJPEG | `LICENSE_OPENJPEG` | `LICENSE_PDFJS_OPENJPEG` |
| qcms | `LICENSE_QCMS` | `LICENSE_PDFJS_QCMS` |

All six notices are included in the embedded asset set and installation ZIP.

## Browser PDF export

PDF export uses the standalone browser bundle from `pdfkit@0.17.2` and `svg-to-pdfkit@0.1.8`. `scripts/pdf-browser.mjs` replaces three filesystem module lookups with errors for string-path reads. The patch validates exact occurrence counts during the build. Fonts and images are supplied as memory bytes; the worker receives embedded fonts through transferable messages.

The worker bundles `buffer@6.0.3` through `buffer/`. File imports use the host file picker; vault access uses `FileIO` and the Obsidian vault API.

## Distribution

Community installation uses `main.js`, `manifest.json`, and `styles.css`. Bundled fonts and PDF resources account for most of the approximately 46 MB main script. Installation and synchronization details are in the [README](../README.md).
