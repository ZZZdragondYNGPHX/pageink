declare module 'pdfkit/js/pdfkit.standalone.js' {
  export default class PDFDocument {
    constructor(options: { size: [number, number]; margin: number; compress: boolean });
    on(event: 'data', listener: (chunk: Uint8Array) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'end', listener: () => void): this;
    registerFont(name: string, bytes: Uint8Array): this;
    end(): void;
  }
}
declare module 'svg-to-pdfkit' {
  import PDFDocument from 'pdfkit/js/pdfkit.standalone.js';
  const render: (doc: PDFDocument, svg: string, x: number, y: number, options?: {
    width: number; height: number; assumePt: boolean;
    fontCallback: () => string;
    imageCallback: (url: string) => Uint8Array | string;
    warningCallback: (message: string) => void;
  }) => void;
  export default render;
}
declare module 'buffer/' { export { Buffer } from 'buffer'; }
declare module 'pageink:assets' { const assets: Record<string, readonly [string, number, string]>; export default assets; }
