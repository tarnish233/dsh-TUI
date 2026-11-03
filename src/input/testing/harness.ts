/**
 * Offline test harness for the input subsystem.
 *
 * Tests use the vendored @earendil-works/pi-tui source build in vendor/pi-tui.
 * The DSH editor/completion seam is installed by src/input/pi-tui-seam.js when
 * the input module loads; there is no pnpm patch and no module-loader redirect.
 */

import { createRequire } from "node:module"
import path from "node:path"

import type { EditorTheme, SelectListTheme, TUI } from "@earendil-works/pi-tui"

export type InputModule = typeof import("../index.ts")

interface PreparedPi {
  packageDir: string
  /** Kept for compatibility with the old harness API. */
  installedPatched: true
}

let prepared: PreparedPi | undefined

/** Resolve the vendored TUI package; the seam is installed by CcEditor itself. */
export async function ensurePatchedPi(): Promise<PreparedPi> {
  if (prepared) return prepared
  const require = createRequire(import.meta.url)
  const packageDir = path.dirname(require.resolve("@earendil-works/pi-tui/package.json"))
  prepared = { packageDir, installedPatched: true }
  return prepared
}

/** Load the input module after the vendored TUI is resolved. */
export async function loadInputModule(): Promise<InputModule> {
  await ensurePatchedPi()
  return import("../index.ts")
}

// --- fake TUI ----------------------------------------------------------

export interface FakeTui {
  terminal: { rows: number; columns: number; kittyProtocolActive: boolean }
  renderRequests: number
  requestRender(): void
}

export function createFakeTui(rows = 40, columns = 80): FakeTui {
  const tui: FakeTui = {
    terminal: { rows, columns, kittyProtocolActive: false },
    renderRequests: 0,
    requestRender() {
      tui.renderRequests += 1
    },
  }
  return tui
}

const identity = (text: string): string => text

export const testSelectListTheme: SelectListTheme = {
  selectedPrefix: identity,
  selectedText: identity,
  description: identity,
  scrollInfo: identity,
  noMatch: identity,
}

export const testEditorTheme: EditorTheme = {
  borderColor: identity,
  selectList: testSelectListTheme,
}

/** Cast a fake TUI to Pi's TUI type (the editor only needs the fields above). */
export function asTui(tui: FakeTui): TUI {
  return tui as unknown as TUI
}

// --- press helpers -----------------------------------------------------

/** Feed raw terminal data and flush any held fragmented-paste bytes. */
export function press(editor: { handleInput(data: string): void; flushInputBuffer?: () => void }, data: string): void {
  editor.handleInput(data)
  editor.flushInputBuffer?.()
}

export function typeText(
  editor: { handleInput(data: string): void; flushInputBuffer?: () => void },
  text: string,
): void {
  for (const grapheme of text) {
    editor.handleInput(grapheme)
  }
  editor.flushInputBuffer?.()
}

/** Render once at the given width so visual-line geometry is initialised. */
export function renderAt(editor: { render(width: number): string[] }, width = 40): string[] {
  return editor.render(width)
}