import type { Rect } from './model';
import type { PreferenceStore } from './preferences';
import type { ElementsLibraryStore } from './elements-library';
import type { MixedHost } from './mixed-host';
import type { CardsHost } from './cards-host';

/** Remembered viewport of one document on this device. */
export interface ViewMemory { page?: string; dx: number; dy: number; zoom: number }
export type ViewSurface = 'body' | 'scratch';

/** Live view state synced to Obsidian's native view header and pane menu. */
export interface WorkspaceChromeState {
  paged: boolean;
  sidebar: boolean;
  reading: boolean;
  scratchOpen: boolean;
  focus: boolean;
  hasPdfPage: boolean;
  hasPdfSource: boolean;
}

/** Workspace operations exposed to host commands and menus. */
export interface WorkspaceActions {
  exportPdf(): void;
  exportPackage(): void;
  openExport(): void;
  openPageSettings(): void;
  openMixed(): void;
  toggleSidebar(): void;
  toggleReading(): void;
  toggleScratch(): void;
  toggleFocus(): void;
  search(): void;
  copyCurrentLink(): void;
  copyCurrentPageText(): void;
  selectCurrentPageText(): void;
  bookmarkCurrentView(): void;
}

/** Everything the workspace needs from Obsidian. Keeps UI code free of host APIs and testable. */
export interface WorkspaceHost {
  prefs: PreferenceStore;
  elements: ElementsLibraryStore;
  text: MixedHost;
  cards: CardsHost;
  openLibrary(): Promise<void>;
  properties(): Promise<void>;
  /** Base name for exported files (the note's file name). */
  fileName(): string;
  /** Writes an export into the vault without overwriting and returns its path. */
  saveExport(name: string, extension: string, bytes: ArrayBuffer): Promise<string>;
  openFile(path: string): Promise<void>;
  copyLink(target: { page?: string; region?: string; embed?: boolean }): Promise<void>;
  openSource(document: string, page: string, rect: Rect): Promise<void>;
  resolveConflict(openCopy: boolean): Promise<void>;
  relinkSource(): void;
  showVersions(): void;
  loadView(surface?: ViewSurface): ViewMemory | undefined;
  saveView(view: ViewMemory, surface?: ViewSurface): void;
  theme(): 'light' | 'dark';
  onThemeChange(listener: () => void): () => void;
  /** Lets host commands reach the mounted workspace; returns a disconnect function. */
  connect(actions: WorkspaceActions): () => void;
  /** Syncs workspace view state to Obsidian's native view-header actions and pane menu. */
  syncChrome?(state: WorkspaceChromeState): void;
  /** Restores keyboard focus to Obsidian's native sidebar toggle button when present. */
  focusSidebarAction?(): void;
}
