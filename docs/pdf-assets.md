# PDF runtime assets

PageInk embeds the unchanged decoder binaries from `pdfjs-dist@5.4.624`, the exact package fixed by `package-lock.json`. PDF.js requests them through `EmbeddedWasm` in `src/assets.ts`; `AssetStore` verifies byte lengths while decompressing them. They process PDF page content locally. No decoder is downloaded at runtime and no user document is sent to a service.

| Asset | Purpose | License | SHA-256 |
| --- | --- | --- | --- |
| `jbig2.wasm` | PDFium JBIG2 decoder | BSD-3-Clause + Apache-2.0 wrapper | `df85117444f0f0150c5c9d0dd8eeab102d705217f838a9f6d46788b6d9b3d681` |
| `openjpeg.wasm` | OpenJPEG JPEG 2000 decoder | BSD-2-Clause + Apache-2.0 wrapper | `67b8e2b162da472e98cb48d3d32e3e38fff481b9b32ff4818e78bb248af88ab2` |
| `qcms_bg.wasm` | qcms ICC color conversion | MIT + Apache-2.0 wrapper | `6017eca5939cde1836e88e6d8cd27ae039246f206515ea4487bdfd0e3fb16e26` |

`jbig2.wasm` is the PDFium-derived decoder distributed by PDF.js; it is required for JBIG2-compressed scans. Its copyright notice is `LICENSE_JBIG2`, with the PDF.js wrapper notice in `LICENSE_PDFJS_JBIG2`. OpenJPEG uses `LICENSE_OPENJPEG` / `LICENSE_PDFJS_OPENJPEG`, and qcms uses `LICENSE_QCMS` / `LICENSE_PDFJS_QCMS`. All six original notices ship inside the embedded asset set and in the installation ZIP. The binaries' strings may contain upstream project and license URLs; those strings do not initiate requests.

Package source: [pdfjs-dist](https://github.com/mozilla/pdfjs-dist) and [PDF.js](https://github.com/mozilla/pdf.js). Bytes and notices come from the pinned npm package, with no local compilation or binary edits.

## Browser PDF export

PDF export uses `pdfkit@0.17.2`'s standalone browser bundle and `svg-to-pdfkit@0.1.8`. `scripts/pdf-browser.mjs` removes the bundle's three filesystem module lookups, replacing its string-path readers with an explicit error. The patch checks the exact occurrence count and fails the build if upstream structure changes. Fonts and images are supplied as memory bytes; the worker receives local embedded fonts by transferable messages.

`Buffer` comes from the MIT browser package `buffer@6.0.3` via `buffer/`, bundled into the worker. It does not load Node's built-in `buffer` on a device. The file picker reads a file only after the user selects it; vault contents are managed through `FileIO` and the host vault API.

## Installation limits

The supported community installation consists of `main.js`, `manifest.json`, and `styles.css`. Embedded fonts and PDF resources make `main.js` approximately 46 MB. This exceeds Obsidian Sync Standard's 5 MB single-file limit; install PageInk independently on each device using that plan. The larger file is retained to preserve offline CJK text export and complete PDF decoding.
