import React from 'react';

// Small, coherent line icons owned by the plugin; no external font or network dependency.
const paths: Record<string, React.ReactNode> = {
  pen: <><path d="m15 4 5 5-10 10-6 1 1-6Z"/><path d="m13 6 5 5M5 15l4 4"/></>,
  highlighter: <><path d="m14 3 7 7-9 9-7-7Z"/><path d="m5 12-2 6 3 3 6-2M3 21h9"/></>,
  erase: <><path d="m15 3 6 6-11 12H6l-4-4Z"/><path d="m8 11 6 6M10 21h11"/></>,
  wholeErase: <><path d="m14 3 7 7-10 10H6l-4-4Z"/><path d="m7 11 7 7M17 17l4 4M21 17l-4 4"/></>,
  selection: <path d="m5 3 14 9-7 2-3 7Z"/>,
  lasso: <><ellipse cx="12" cy="10" rx="9" ry="7" strokeDasharray="2 3"/><path d="M7 16c-5 0-5 6-1 6 3 0 4-4 2-7"/></>,
  hand: <path d="M8 13V6a2 2 0 0 1 4 0v6-8a2 2 0 0 1 4 0v8-6a2 2 0 0 1 4 0v9c0 8-10 9-13 3l-3-5c-1-3 2-4 4 0Z"/>,
  text: <path d="M4 5h16M12 5v15M8 20h8M4 5v3M20 5v3"/>,
  image: <><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/></>,
  rectangle: <rect x="4" y="5" width="16" height="14" rx="2"/>, ellipse: <ellipse cx="12" cy="12" rx="9" ry="7"/>, diamond: <path d="m12 2 10 10-10 10L2 12Z"/>, line: <path d="m5 19 14-14"/>, arrow: <path d="m5 19 14-14M8 5h11v11"/>,
  undo: <path d="m8 4-5 5 5 5M3 9h11a6 6 0 0 1 0 12"/>, redo: <path d="m16 4 5 5-5 5M21 9H10a6 6 0 0 0 0 12"/>,
  nav: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></>, search: <><circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6"/></>, export: <path d="M12 15V3m-4 4 4-4 4 4M5 12H3v9h18v-9h-2"/>,
  save: <><path d="m4 12 5 5L20 6"/><path d="M20 13v7H4V4h9"/></>, scratch: <path d="M5 3h14v18H5zM8 3v18M11 8h5M11 12h5M11 16h3"/>, focus: <path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5"/>,
  close: <path d="m6 6 12 12M6 18l12-12"/>, down: <path d="m6 9 6 6 6-6"/>, plus: <path d="M12 5v14M5 12h14"/>, more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  copy: <><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/></>, trash: <path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>, link: <><path d="m9 15 6-6M8 16l-2 2a4 4 0 0 1-5-5l5-5a4 4 0 0 1 5 0M16 8l2-2a4 4 0 0 1 5 5l-5 5a4 4 0 0 1-5 0" transform="translate(-1)"/></>, page: <path d="M5 3h10l4 4v14H5Z M15 3v5h4M8 12h8M8 16h5"/>,
  grip: <path d="M8 7h.01M8 12h.01M8 17h.01M13 7h.01M13 12h.01M13 17h.01" strokeWidth="3"/>,
};
export function InkIcon({ name }: { name: string }) { return <svg className="ink-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.more}</svg>; }
export function IconButton({ icon, label, children, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string }) { return <button type="button" title={label} aria-label={label} className={`ink-icon-button ${className}`} {...props}><InkIcon name={icon}/>{children}</button>; }
