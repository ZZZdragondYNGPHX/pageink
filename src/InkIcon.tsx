import React from 'react';
import {
  Pencil, Highlighter, Eraser, Lasso, MousePointer2, Hand, Type, Shapes, ImagePlus, Crop,
  RectangleHorizontal, Circle, Diamond, Minus, ArrowUpRight, Undo2, Redo2, PanelLeft,
  NotebookPen, Search, Share, Ellipsis, X, ChevronDown, ChevronUp, ChevronRight, ChevronLeft,
  Check, Plus, Trash2, Copy, CopyPlus, Link, Code, Bookmark, Files, File, FilePlus2,
  Scan, SlidersHorizontal, ZoomIn, ZoomOut, Maximize, MoveHorizontal, Expand, ExternalLink,
  History, RefreshCw, FileText, ArrowUp, ArrowDown, GripVertical, TriangleAlert, LocateFixed,
  ArrowRightToLine, Droplet, PenTool, Pointer, LayoutDashboard, Notebook, BookOpen, FileType, Package,
  CalendarDays, FolderOpen, LayoutGrid, List, PanelRight, PanelsTopLeft, type LucideIcon,
} from 'lucide-react';

// Official Lucide SVG assets, pinned in package-lock.json. ISC + Feather MIT notices ship with the bundle.
// Keep stable PageInk identifiers so tools and host surfaces share a single icon vocabulary.
const icons: Record<string, LucideIcon> = {
  pen: Pencil, highlighter: Highlighter, eraser: Eraser, lasso: Lasso, select: MousePointer2,
  hand: Hand, text: Type, shape: Shapes, image: ImagePlus, capture: Crop,
  rectangle: RectangleHorizontal, ellipse: Circle, diamond: Diamond, line: Minus, arrow: ArrowUpRight,
  undo: Undo2, redo: Redo2, sidebar: PanelLeft, scratch: NotebookPen, search: Search, share: Share,
  more: Ellipsis, close: X, down: ChevronDown, up: ChevronUp, right: ChevronRight, left: ChevronLeft,
  check: Check, plus: Plus, minus: Minus, trash: Trash2, copy: Copy, duplicate: CopyPlus,
  link: Link, embed: Code, bookmark: Bookmark, pages: Files, page: File, pageAdd: FilePlus2,
  margins: Scan, sliders: SlidersHorizontal, zoomIn: ZoomIn, zoomOut: ZoomOut, fit: Maximize,
  fitWidth: MoveHorizontal, focus: Expand, external: ExternalLink, history: History,
  relink: RefreshCw, docText: FileText, moveUp: ArrowUp, moveDown: ArrowDown, grip: GripVertical,
  warning: TriangleAlert, locate: LocateFixed, toBody: ArrowRightToLine, drop: Droplet,
  pressure: PenTool, finger: Pointer, canvas: LayoutDashboard, notebook: Notebook, read: BookOpen,
  pdf: FileType, package: Package, calendar: CalendarDays, folderOpen: FolderOpen, grid: LayoutGrid, list: List, dock: PanelRight, float: PanelsTopLeft,
};
export const hasIcon = (name: string) => name in icons;
export function InkIcon({ name, className = '' }: { name: string; className?: string }) {
  const Icon = icons[name] ?? Ellipsis;
  return <Icon className={`ink-icon ${className}`} size={20} strokeWidth={1.75} aria-hidden="true"/>;
}
export const IconButton = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string; shortcut?: string }>(
  function IconButton({ icon, label, shortcut, children, className = '', ...props }, ref) {
    return <button ref={ref} type="button" title={shortcut ? `${label} (${shortcut})` : label} aria-label={label} className={`ink-icon-button ${className}`} {...props}><InkIcon name={icon}/>{children}</button>;
  });
