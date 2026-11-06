/** Shared tools display contract. DSH still owns all execution and durable facts. */
import { defaults, type Settings, type TOOL_SETTING_KEYS } from '../config.ts'

export type ToolIoSection = 'input' | 'output'
export interface ToolDetailsRequest {
  readonly callId: string
  readonly section: ToolIoSection
}
export type ToolPreferences = Pick<Settings, typeof TOOL_SETTING_KEYS[number]>
export interface ToolViewOptions extends Partial<ToolPreferences> {
  /** A modal owns focus; background transcript click targets stay inert. */
  mouseBlocked?: boolean
  onToolDetails?: (request: ToolDetailsRequest) => void
  /** Owner coordinates mouse single-expand and viewport anchoring before state flips. */
  onToolExpansionRequest?: (key: string, expanded: boolean) => void
}
export interface ToolGroupContext {
  readonly key: string
  readonly isExpanded: () => boolean
  readonly collapse: () => void
}
export interface ToolSummaryInfo {
  readonly label: string
  /** Includes the label once, e.g. "Bash npm test" or "Read src/a.ts". */
  readonly text: string
  readonly durationMs?: number
}

export function toolPreferences(options: Partial<ToolPreferences>): ToolPreferences {
  return {
    groupTools: options.groupTools ?? defaults.groupTools,
    expandTools: options.expandTools ?? defaults.expandTools,
    expandedInputMaxLines: options.expandedInputMaxLines ?? defaults.expandedInputMaxLines,
    expandedOutputMaxLines: options.expandedOutputMaxLines ?? defaults.expandedOutputMaxLines,
    toolLabelClip: options.toolLabelClip ?? defaults.toolLabelClip,
    diffViewMode: options.diffViewMode ?? defaults.diffViewMode,
    diffIndicatorMode: options.diffIndicatorMode ?? defaults.diffIndicatorMode,
    diffSplitMinWidth: options.diffSplitMinWidth ?? defaults.diffSplitMinWidth,
    editDiffCollapsedLines: options.editDiffCollapsedLines ?? defaults.editDiffCollapsedLines,
    writeDiffCollapsedLines: options.writeDiffCollapsedLines ?? defaults.writeDiffCollapsedLines,
    diffWordWrap: options.diffWordWrap ?? defaults.diffWordWrap,
  }
}
