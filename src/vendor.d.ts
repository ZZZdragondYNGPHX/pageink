declare module 'pdfkit/js/pdfkit.standalone.js' { const PDFDocument: any; export default PDFDocument; }
declare module 'svg-to-pdfkit' { const render: (doc: any, svg: string, x: number, y: number, options?: any) => void; export default render; }
declare module 'pageink:assets' { const assets: Record<string, readonly [string, number, string]>; export default assets; }
