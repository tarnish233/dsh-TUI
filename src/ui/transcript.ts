/**
 * Component adapter for the transcript store.
 *
 * The view owns one block component per stable transcript item id. Stable
 * items keep their rendered lines; only an item whose `version` changed (the
 * live attempt while tokens arrive) re-renders. The parent still owns the TUI
 * frame scheduler: this component never calls requestRender or writes stdout.
 */
import type { Component } from '@earendil-works/pi-tui'
import type { TranscriptStore } from '../state/transcript.ts'
import { type ItemBlock, createItemBlock, type TranscriptViewOptions } from './blocks.ts'
import { fit } from './text.ts'

export interface TranscriptViewOptionsShape {
  showThinking: boolean
  expandTools: boolean
}

interface CachedEntry {
  block: ItemBlock
  version: number
  kind: ItemBlock['kind']
}

export class TranscriptView implements Component {
  readonly store: TranscriptStore
  /** Mutable by the parent; assignment of a new object is also supported. */
  options: TranscriptViewOptionsShape
  private readonly flags: TranscriptViewOptions
  private readonly cache = new Map<string, CachedEntry>()

  constructor(store: TranscriptStore, options: TranscriptViewOptionsShape) {
    this.store = store
    this.options = options
    this.flags = { showThinking: options.showThinking, expandTools: options.expandTools }
  }

  private syncFlags(): void {
    this.flags.showThinking = this.options.showThinking
    this.flags.expandTools = this.options.expandTools
  }

  /** Diagnostics/tests: number of item components currently retained. */
  get cachedItemCount(): number {
    return this.cache.size
  }

  invalidate(): void {
    for (const entry of this.cache.values()) entry.block.invalidate()
  }

  render(width: number): string[] {
    this.syncFlags()
    const safeWidth = Math.max(1, Math.floor(width))
    const seen = new Set<string>()
    const out: string[] = []
    for (const item of this.store.items) {
      const key = `${item.kind}|${item.id}`
      seen.add(key)
      let entry = this.cache.get(key)
      if (entry === undefined || entry.kind !== item.kind) {
        const block = createItemBlock(item, this.flags)
        entry = { block, version: item.version, kind: item.kind }
        this.cache.set(key, entry)
      } else if (entry.version !== item.version) {
        entry.block.update(item)
        entry.version = item.version
      }
      const withCwd = entry.block as ItemBlock & { setCwd?: (cwd: string) => void }
      if (typeof withCwd.setCwd === 'function') withCwd.setCwd(this.store.info?.cwd ?? '')
      const lines = entry.block.render(safeWidth)
      if (lines.length === 0) continue
      if (out.length > 0) out.push('')
      for (const line of lines) out.push(fit(line, safeWidth))
    }
    for (const key of [...this.cache.keys()]) {
      if (!seen.has(key)) this.cache.delete(key)
    }
    return out
  }
}
