/**
 * Native DSH `@file` mention completion on the single Pi editor state.
 *
 * The provider owns no grammar and no index of its own: DSH's public
 * `@deepseek-ai/dsh-file-reference/grammar` decides whether the cursor is inside
 * an `@path` / `@"path with spaces"` token (`activeAtToken`) and how an accepted
 * candidate is spelled (`formatFileMention`), while the parent supplies the
 * candidates through `fileReferences(query, signal)`. Pi's own insertion and
 * cursor rules stay the only edit path (`Editor.applyCompletion`), so there is
 * no second editor state here.
 *
 * Everything is offline: no model call, no filesystem scan by the provider, no
 * `fd` and no terminal.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  asTui,
  createFakeTui,
  loadInputModule,
  press,
  renderAt,
  testEditorTheme,
  typeText,
} from "../src/input/testing/harness.ts"
import type { CcSubmitPayload, NativeCommandEntry } from "../src/input/index.ts"
import type { FileReferenceCandidate, SkillCatalogEntry } from "../src/backend/types.ts"
import {
  CombinedAutocompleteProvider,
  type AutocompleteSuggestions,
  type SlashCommand,
} from "#pi-tui"

const mod = await loadInputModule()
type Provider = InstanceType<typeof mod.NativeAutocompleteProvider>
type TestEditor = InstanceType<typeof mod.CcEditor>

const noopSignal = () => new AbortController().signal

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** One native candidate row exactly as DSH's `fileReferences.list` returns it. */
function file(filePath: string): FileReferenceCandidate {
  return { path: filePath, kind: "file" }
}

function dir(dirPath: string): FileReferenceCandidate {
  return { path: dirPath, kind: "directory" }
}

interface ProviderOptions {
  commands?: readonly NativeCommandEntry[]
  skills?: readonly SkillCatalogEntry[]
  basePath?: string
  refreshSkills?: (signal: AbortSignal) => Promise<void>
  fileReferences?: (query: string, signal: AbortSignal) => Promise<readonly FileReferenceCandidate[]>
}

function makeProvider(options: ProviderOptions = {}): Provider {
  return new mod.NativeAutocompleteProvider({
    commands: () => options.commands ?? [],
    skills: () => options.skills ?? [],
    basePath: options.basePath ?? process.cwd(),
    ...(options.refreshSkills ? { refreshSkills: options.refreshSkills } : {}),
    ...(options.fileReferences ? { fileReferences: options.fileReferences } : {}),
  })
}

/** Suggest at the end of `text` (or at an explicit column inside it). */
async function suggest(
  provider: Provider,
  text: string,
  options: { force?: boolean; signal?: AbortSignal; cursorCol?: number } = {},
): Promise<AutocompleteSuggestions | null> {
  const col = options.cursorCol ?? text.length
  return await provider.getSuggestions([text], 0, col, {
    signal: options.signal ?? noopSignal(),
    ...(options.force === true ? { force: true } : {}),
  })
}

function values(suggestions: AutocompleteSuggestions | null): string[] {
  return (suggestions?.items ?? []).map((item) => item.value)
}

// --- candidate mapping --------------------------------------------------

test("bare @ asks the native source with an empty query and returns its rows", async () => {
  const queries: string[] = []
  const provider = makeProvider({
    fileReferences: async (query) => {
      queries.push(query)
      return [dir("src"), file("README.md")]
    },
  })

  const suggestions = await suggest(provider, "@")
  assert.deepEqual(queries, [""], "the grammar query after the bare @ is empty")
  assert.equal(suggestions?.prefix, "@", "the active token prefix is the replacement range")
  assert.deepEqual(suggestions?.items, [
    { value: "@src/", label: "src/" },
    { value: "@README.md", label: "README.md" },
  ])
})

test("native provider order is passed through unchanged (no local sort or fuzzy)", async () => {
  const provider = makeProvider({
    fileReferences: async () => [
      // Deliberately not alphabetical and not "best match first".
      dir("zeta"),
      file("src/zebra-fuzzy.ts"),
      file("src/apple.ts"),
      dir("src/nested"),
    ],
  })

  const suggestions = await suggest(provider, "@src")
  assert.equal(suggestions?.prefix, "@src")
  assert.deepEqual(values(suggestions), [
    "@zeta/",
    "@src/zebra-fuzzy.ts",
    "@src/apple.ts",
    "@src/nested/",
  ])
  assert.deepEqual(
    suggestions?.items.map((item) => item.label),
    ["zeta/", "zebra-fuzzy.ts", "apple.ts", "nested/"],
  )
  // Parent path only; root-level entries carry no description row.
  assert.deepEqual(
    suggestions?.items.map((item) => item.description),
    [undefined, "src/", "src/", "src/"],
  )
})

test("nested queries keep the grammar query and the documented mention values", async () => {
  const queries: string[] = []
  const provider = makeProvider({
    fileReferences: async (query) => {
      queries.push(query)
      return query === "src/" ? [file("src/main.ts"), dir("src/ui")] : []
    },
  })

  const nested = await suggest(provider, "@src/")
  assert.deepEqual(queries, ["src/"])
  assert.equal(nested?.prefix, "@src/")
  assert.deepEqual(values(nested), ["@src/main.ts", "@src/ui/"])

  // An accepted unquoted directory keeps its trailing slash and the cursor at
  // the end, so the next keystroke continues inside the same token.
  const applied = provider.applyCompletion(["@src/"], 0, 5, nested!.items[1]!, "@src/")
  assert.deepEqual(applied, { lines: ["@src/ui/"], cursorLine: 0, cursorCol: 8 })
})

test("spaced paths use DSH quoting and keep a submit-ready closed quote", async () => {
  const queries: string[] = []
  const provider = makeProvider({
    fileReferences: async (query) => {
      queries.push(query)
      if (query.startsWith("my ")) return [dir("my dir"), file("my notes.txt")]
      return []
    },
  })

  const suggestions = await suggest(provider, '@"my ')
  assert.deepEqual(queries, ["my "], "the query is the text after the opening quote")
  assert.equal(suggestions?.prefix, '@"my ')
  assert.deepEqual(suggestions?.items, [
    { value: '@"my dir/', label: "my dir/" },
    { value: '@"my notes.txt"', label: "my notes.txt" },
  ])

  // Directory: the draft holds a closed, submittable mention and the cursor
  // stops before the closing quote so completion can descend one more level.
  const appliedDir = provider.applyCompletion(
    ['@"my '],
    0,
    5,
    suggestions!.items[0]!,
    '@"my ',
  )
  assert.deepEqual(appliedDir, { lines: ['@"my dir/"'], cursorLine: 0, cursorCol: 9 })
  const continued = `${appliedDir.lines[0]!.slice(0, appliedDir.cursorCol)}f${appliedDir.lines[0]!.slice(appliedDir.cursorCol)}`
  assert.equal(continued, '@"my dir/f"', "typing after the accept stays inside the quote")

  // File: `formatFileMention` already closes the quote; only Pi adds the space.
  const appliedFile = provider.applyCompletion(
    ['@"my '],
    0,
    5,
    suggestions!.items[1]!,
    '@"my ',
  )
  assert.deepEqual(appliedFile, { lines: ['@"my notes.txt" '], cursorLine: 0, cursorCol: 16 })
})

test("a quote already after the cursor is deduplicated by Pi's own rule", async () => {
  const provider = makeProvider({
    fileReferences: async () => [file("my dir/inner.txt")],
  })
  // Drill-down state: closed quote in the draft, cursor before it.
  const line = '@"my dir/"'
  const cursorCol = 9
  const suggestions = await suggest(provider, line, { cursorCol })
  assert.equal(suggestions?.prefix, '@"my dir/')
  const applied = provider.applyCompletion([line], 0, cursorCol, suggestions!.items[0]!, suggestions!.prefix)
  assert.deepEqual(applied, { lines: ['@"my dir/inner.txt" '], cursorLine: 0, cursorCol: 20 })
})

test("representable-only candidates: quotes and control characters are dropped", async () => {
  const provider = makeProvider({
    fileReferences: async () =>
      [
        file('weird"name.txt'),
        file("bad\u001bname.txt"),
        file("ok.txt"),
      ] as readonly FileReferenceCandidate[],
  })
  const suggestions = await suggest(provider, "@")
  assert.deepEqual(values(suggestions), ["@ok.txt"], "a path the grammar cannot spell adds no row")

  const empty = makeProvider({ fileReferences: async () => [file('weird"name.txt')] })
  assert.equal(await suggest(empty, "@"), null, "no valid row means no menu, not a broken mention")
})

test("malformed candidate records are ignored instead of breaking the menu", async () => {
  const provider = makeProvider({
    fileReferences: async () =>
      [
        { path: "", kind: "file" },
        { path: "x", kind: "symlink" },
        { path: "dir", kind: "directory" },
        "not-a-candidate",
        null,
      ] as unknown as readonly FileReferenceCandidate[],
  })
  const suggestions = await suggest(provider, "@")
  assert.deepEqual(values(suggestions), ["@dir/"])
  assert.deepEqual(suggestions?.items[0]?.label, "dir/")
})

// --- token boundaries ---------------------------------------------------

test("only DSH grammar tokens trigger: emails and non-boundary @ stay with Pi", async () => {
  const queries: string[] = []
  const provider = makeProvider({
    fileReferences: async (query) => {
      queries.push(query)
      return [file("alpha.txt")]
    },
  })

  assert.equal(await suggest(provider, "abc@def"), null, "an email is never an @file trigger")
  assert.equal(await suggest(provider, "o beim@heim.de"), null)
  assert.equal(await suggest(provider, "(@src"), null, "wrapper parentheses are not DSH tokens")
  assert.equal(await suggest(provider, "look at `@src"), null)
  assert.deepEqual(queries, [], "the native source is never asked for a non-token @")

  assert.deepEqual(values(await suggest(provider, "see @al")), ["@alpha.txt"])
  assert.deepEqual(values(await suggest(provider, "  @al")), ["@alpha.txt"])
  assert.deepEqual(queries, ["al", "al"])

  // Inside the token, the text after the cursor is not part of the query.
  const mid = await suggest(provider, "x @alpha.txt", { cursorCol: 4 })
  assert.equal(mid?.prefix, "@a")
  assert.equal(queries.at(-1), "a")

  // Multi-line drafts complete on the cursor line only.
  const multi = await provider.getSuggestions(["first line", "then @al"], 1, 9, { signal: noopSignal() })
  assert.deepEqual(values(multi), ["@alpha.txt"])
  assert.equal(queries.at(-1), "al")
})

test("a forced Tab keeps the native token path and still completes plain paths", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "dsh-tui-mentions-force-"))
  try {
    await mkdir(path.join(cwd, "src"), { recursive: true })
    await writeFile(path.join(cwd, "src", "main.ts"), "")
    const files: FileReferenceCandidate[] = [file("src/main.ts")]
    const provider = makeProvider({ basePath: cwd, fileReferences: async () => files })

    const forced = await suggest(provider, "@src/ma", { force: true })
    assert.deepEqual(values(forced), ["@src/main.ts"])

    // Plain paths are not @ tokens: Pi's own completion still answers them.
    const delegated = await suggest(provider, "src/ma", { force: true })
    assert.deepEqual(values(delegated), ["src/main.ts"])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

// --- no callback --------------------------------------------------------

test("without a fileReferences callback @ stays Pi's own behavior (no scan, no fd)", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "dsh-tui-mentions-none-"))
  try {
    await mkdir(path.join(cwd, "src"), { recursive: true })
    await writeFile(path.join(cwd, "src", "main.ts"), "")
    await writeFile(path.join(cwd, "alpha.txt"), "")

    const commands: SlashCommand[] = [
      {
        name: "deploy",
        description: "Deploy",
        getArgumentCompletions: (prefix) =>
          ["staging", "production"]
            .filter((value) => value.startsWith(prefix))
            .map((value) => ({ value, label: value })),
      },
    ]
    const provider = makeProvider({ commands, basePath: cwd })

    // No local @ index exists here: nothing is scanned or guessed.
    assert.equal(await suggest(provider, "@"), null)
    assert.equal(await suggest(provider, "@alpha"), null)
    assert.equal(await suggest(provider, "@src/ma"), null)

    // Non-@ contexts are still exactly Pi's combined provider.
    const reference = new CombinedAutocompleteProvider([...commands], cwd)
    for (const item of [{ text: "src/ma" }, { text: "src/" }, { text: "/deploy st" }, { text: "" }]) {
      const actual = await suggest(provider, item.text, { force: item.text === "" })
      const expected = await suggest(reference as unknown as Provider, item.text, {
        force: item.text === "",
      })
      assert.deepEqual(actual, expected, `delegation mismatch for ${JSON.stringify(item)}`)
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

// --- lazy grammar load (offline demo without native DSH peers) ----------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const inputIndexUrl = pathToFileURL(path.join(repoRoot, "src", "input", "index.ts")).href

/**
 * Preload hook that makes `@deepseek-ai/dsh-file-reference` unresolvable, i.e.
 * the state of the explicit offline `--demo` entry when the native DSH peers are
 * not installed.
 */
const BLOCK_GRAMMAR_HOOK = `import { registerHooks } from "node:module"
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes("dsh-file-reference")) {
      throw new Error("blocked by test: the native DSH @file grammar is not installed")
    }
    return nextResolve(specifier, context)
  },
})
`

/** Run one probe module in a child process with the grammar blocked. */
function runProbeWithoutGrammar(dir: string, probeSource: string): { status: number | null; stdout: string; stderr: string } {
  const hookPath = path.join(dir, "block-grammar.mjs")
  const probePath = path.join(dir, "probe.ts")
  writeFileSync(hookPath, BLOCK_GRAMMAR_HOOK)
  writeFileSync(probePath, probeSource)
  const result = spawnSync(process.execPath, ["--import", hookPath, probePath], {
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

test("slash, argument and non-@ path completion never load the @file grammar", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dsh-tui-mentions-lazy-a-"))
  try {
    const probe = `import { NativeAutocompleteProvider } from ${JSON.stringify(inputIndexUrl)}

const provider = new NativeAutocompleteProvider({
  commands: () => [{ name: "help", description: "Display commands" }],
  skills: () => [],
  basePath: "/",
})
const signal = new AbortController().signal
const pathResult = await provider.getSuggestions(["src/ma"], 0, 6, { signal })
const atResult = await provider.getSuggestions(["@alpha"], 0, 6, { signal })
const slash = await provider.getSuggestions(["/h"], 0, 2, { signal })
// The module graph already proved the grammar is unavailable: this provider
// loaded anyway, and no request above needed it.
console.log("path", JSON.stringify(pathResult))
console.log("at", JSON.stringify(atResult))
console.log("slash", JSON.stringify(slash?.items.map((item) => item.value)))
setTimeout(() => console.log("done"), 50)
`
    const result = runProbeWithoutGrammar(dir, probe)
    assert.equal(result.status, 0, `probe failed: ${result.stderr}`)
    assert.match(result.stdout, /^path null$/m)
    assert.match(result.stdout, /^at null$/m)
    assert.match(result.stdout, /^slash \[\"help\"\]$/m)
    assert.match(result.stdout, /^done$/m, "the process settled cleanly")
    assert.doesNotMatch(result.stderr, /UnhandledPromiseRejection|unhandled/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a missing @file grammar is a silent empty native domain, not an unhandled rejection", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dsh-tui-mentions-lazy-b-"))
  try {
    const probe = `import { NativeAutocompleteProvider } from ${JSON.stringify(inputIndexUrl)}

let calls = 0
const provider = new NativeAutocompleteProvider({
  commands: () => [],
  skills: () => [],
  basePath: "/",
  fileReferences: async () => {
    calls += 1
    return [{ path: "alpha.txt", kind: "file" }]
  },
})
const signal = new AbortController().signal
const first = await provider.getSuggestions(["@al"], 0, 3, { signal })
const second = await provider.getSuggestions(["@a"], 0, 2, { signal })
const pathResult = await provider.getSuggestions(["src/ma"], 0, 6, { signal })
console.log("first", JSON.stringify(first))
console.log("second", JSON.stringify(second))
console.log("path", JSON.stringify(pathResult))
// The failed load is cached, so the candidate source is never asked.
console.log("calls", calls)
setTimeout(() => console.log("done"), 50)
`
    const result = runProbeWithoutGrammar(dir, probe)
    assert.equal(result.status, 0, `probe failed: ${result.stderr}`)
    assert.match(result.stdout, /^first null$/m, "no rows without the grammar")
    assert.match(result.stdout, /^second null$/m)
    assert.match(result.stdout, /^path null$/m, "plain paths still delegate to Pi")
    assert.match(result.stdout, /^calls 0$/m, "the grammar is checked before any domain query")
    assert.match(result.stdout, /^done$/m)
    assert.doesNotMatch(result.stderr, /UnhandledPromiseRejection|unhandled/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a callback never swallows slash, argument or plain-path completion", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "dsh-tui-mentions-delegate-"))
  try {
    await mkdir(path.join(cwd, "src"), { recursive: true })
    await writeFile(path.join(cwd, "src", "main.ts"), "")
    const commands: SlashCommand[] = [
      {
        name: "deploy",
        description: "Deploy",
        getArgumentCompletions: (prefix) =>
          ["staging", "production"]
            .filter((value) => value.startsWith(prefix))
            .map((value) => ({ value, label: value })),
      },
    ]
    let calls = 0
    const provider = makeProvider({
      commands,
      basePath: cwd,
      skills: [{ name: "review", description: "Review", modelInvocable: true }],
      fileReferences: async () => {
        calls += 1
        return [file("src/main.ts")]
      },
    })

    assert.deepEqual(values(await suggest(provider, "/rev")), ["review"])
    assert.deepEqual(values(await suggest(provider, "/deploy st")), ["staging"])
    assert.deepEqual(values(await suggest(provider, "src/ma")), ["src/main.ts"])
    assert.deepEqual(values(await suggest(provider, "/deploy @")), ["@src/main.ts"])
    assert.equal(calls, 1, "only the @ token asks the native file source")
    assert.equal(provider.shouldTriggerFileCompletion(["/rev"], 0, 4), false)
    assert.equal(provider.shouldTriggerFileCompletion(["@src"], 0, 4), true)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

// --- failure, cancellation, staleness ----------------------------------

test("a rejected native query is silently empty and stays retryable", async () => {
  let calls = 0
  const provider = makeProvider({
    fileReferences: async () => {
      calls += 1
      throw new Error("native file discovery unavailable")
    },
  })

  assert.equal(await suggest(provider, "@sr"), null, "a failed domain contributes no rows")
  await sleep(0)
  assert.equal(calls, 1)
  assert.equal(await suggest(provider, "@sr"), null)
  await sleep(0)
  assert.equal(calls, 2, "a later query asks again instead of memoizing the failure")
})

test("a throwing source, a non-array result and a malformed row never surface", async () => {
  const throwing = new mod.NativeAutocompleteProvider({
    commands: () => [],
    skills: () => [],
    basePath: process.cwd(),
    fileReferences: (() => {
      throw new Error("sync throw")
    }) as unknown as ProviderOptions["fileReferences"],
  })
  assert.equal(await suggest(throwing, "@"), null)

  const nonArray = makeProvider({
    fileReferences: (async () => ({ items: [] })) as unknown as ProviderOptions["fileReferences"],
  })
  assert.equal(await suggest(nonArray, "@"), null)
})

test("a source-triggered synchronous abort does not wait for its abandoned promise", async () => {
  const controller = new AbortController()
  let calls = 0
  const provider = makeProvider({
    fileReferences: async () => {
      calls += 1
      controller.abort()
      return await new Promise<readonly FileReferenceCandidate[]>(() => {})
    },
  })

  assert.equal(await suggest(provider, "@a", { signal: controller.signal }), null)
  assert.equal(calls, 1)
})

test("an aborted request resolves empty immediately and never reopens the menu", async () => {
  let abortedSignal: AbortSignal | undefined
  let started: (() => void) | undefined
  let release: (() => void) | undefined
  const provider = makeProvider({
    fileReferences: async (_query, signal) => {
      abortedSignal = signal
      started?.()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return [file("late.txt")]
    },
  })

  // Abort while the domain query is genuinely in flight.
  const inFlight = new Promise<void>((resolve) => {
    started = resolve
  })
  const controller = new AbortController()
  const pending = suggest(provider, "@la", { signal: controller.signal })
  await inFlight
  controller.abort()
  // Abort resolves the request without waiting for the domain query to settle.
  assert.equal(await pending, null)
  assert.equal(abortedSignal?.aborted, true)
  release?.()
  await sleep(0)

  // An already-aborted request never reaches the domain query at all.
  let calls = 0
  const counting = makeProvider({
    fileReferences: async () => {
      calls += 1
      return [file("a.txt")]
    },
  })
  const skipped = await suggest(counting, "@a", { signal: AbortSignal.abort() })
  assert.equal(skipped, null)
  assert.equal(calls, 0)
})

test("a late resolution after abort is ignored (a stale request cannot reopen)", async () => {
  let resolveQuery: ((rows: readonly FileReferenceCandidate[]) => void) | undefined
  const provider = makeProvider({
    fileReferences: async () =>
      await new Promise<readonly FileReferenceCandidate[]>((resolve) => {
        resolveQuery = resolve
      }),
  })

  const controller = new AbortController()
  const request = suggest(provider, "@st", { signal: controller.signal })
  resolveQuery?.([file("stale.txt")])
  controller.abort()
  assert.equal(await request, null, "the aborted request yields no rows even if it settled")
})

test("@file completion never refreshes skills (and slash still does)", async () => {
  let refreshes = 0
  const provider = makeProvider({
    commands: [{ name: "help", description: "Display commands" }],
    skills: [{ name: "review", description: "Review", modelInvocable: true }],
    fileReferences: async () => [file("alpha.txt")],
    refreshSkills: async () => {
      refreshes += 1
    },
  })

  assert.deepEqual(values(await suggest(provider, "@")), ["@alpha.txt"])
  assert.deepEqual(values(await suggest(provider, "src/ma")), [])
  assert.deepEqual(values(await suggest(provider, "@alpha")), ["@alpha.txt"])
  await sleep(0)
  assert.equal(refreshes, 0, "file/`@`/path queries never start a catalog refresh")

  assert.deepEqual(values(await suggest(provider, "/rev")), ["review"])
  await sleep(0)
  assert.equal(refreshes, 1, "the slash menu keeps its existing refresh behavior")
})

// --- CcEditor integration ----------------------------------------------

interface Harness {
  editor: TestEditor
  payloads: CcSubmitPayload[]
}

function makeEditor(provider: Provider): Harness {
  const tui = createFakeTui()
  const editor = new mod.CcEditor(asTui(tui), testEditorTheme)
  const harness: Harness = { editor, payloads: [] }
  editor.setAutocompleteProvider(provider)
  editor.onSubmitContent = (payload: CcSubmitPayload) => {
    harness.payloads.push(payload)
  }
  renderAt(editor, 80)
  return harness
}

test("Enter and Tab only fill an @ candidate; the second Enter submits", async () => {
  const provider = makeProvider({ fileReferences: async () => [file("main.ts")] })

  const entered = makeEditor(provider)
  typeText(entered.editor, "@ma")
  await sleep(60)
  assert.equal(entered.editor.isShowingAutocomplete(), true, "typing @ auto-opens the native menu")

  entered.editor.handleInput("\r")
  assert.equal(entered.editor.getText(), "@main.ts ", "the mention is applied with a trailing space")
  assert.equal(entered.payloads.length, 0, "Enter accepts/fills only; it never submits an @ candidate")
  assert.equal(entered.editor.isShowingAutocomplete(), false)

  entered.editor.handleInput("\r")
  assert.equal(entered.payloads.length, 1, "a second Enter submits the completed draft")
  assert.equal(entered.payloads[0]?.text, "@main.ts")
  assert.deepEqual(entered.payloads[0]?.snapshot.lines, ["@main.ts "])

  const tabbed = makeEditor(provider)
  typeText(tabbed.editor, "@ma")
  tabbed.editor.handleInput("\t")
  await sleep(60)
  assert.equal(tabbed.editor.getText(), "@main.ts ", "Tab accepts into the draft only")
  assert.equal(tabbed.payloads.length, 0)
})

test("Enter never submits even when several candidates are listed", async () => {
  const provider = makeProvider({
    fileReferences: async () => [file("src/main.ts"), dir("src/ui"), file("src/app.ts")],
  })
  const { editor, payloads } = makeEditor(provider)

  typeText(editor, "@src")
  await sleep(60)
  assert.equal(editor.isShowingAutocomplete(), true)
  press(editor, "\x0e") // Ctrl+N moves the highlight: main.ts -> ui/
  editor.handleInput("\r")
  assert.equal(editor.getText(), "@src/ui/", "the highlighted candidate is applied")
  assert.equal(payloads.length, 0)
})

test("a spaced directory keeps a closed quote and keeps drilling on the same editor", async () => {
  const queries: string[] = []
  const provider = makeProvider({
    fileReferences: async (query) => {
      queries.push(query)
      if (query === "my ") return [dir("my dir")]
      if (query === "my dir/f") return [file("my dir/final notes.txt")]
      return []
    },
  })
  const { editor, payloads } = makeEditor(provider)

  typeText(editor, '@"my ')
  await sleep(60)
  assert.equal(editor.isShowingAutocomplete(), true)
  editor.handleInput("\r")

  // Submittable, closed mention with the cursor before the closing quote.
  assert.equal(editor.getText(), '@"my dir/"')
  assert.deepEqual(editor.getCursor(), { line: 0, col: 9 })
  assert.equal(payloads.length, 0, "a directory accept does not submit")

  typeText(editor, "f")
  assert.equal(editor.getText(), '@"my dir/f"')
  await sleep(60)
  assert.equal(editor.isShowingAutocomplete(), true, "the drilled query reopens the menu")
  assert.equal(queries.at(-1), "my dir/f")

  editor.handleInput("\r")
  assert.equal(editor.getText(), '@"my dir/final notes.txt" ')
  assert.equal(payloads.length, 0)
  editor.handleInput("\r")
  assert.equal(payloads.length, 1)
  assert.equal(payloads[0]?.text, '@"my dir/final notes.txt"')
})

test("an unquoted directory accept keeps completing in the same token", async () => {
  const queries: string[] = []
  const provider = makeProvider({
    fileReferences: async (query) => {
      queries.push(query)
      if (query === "sr") return [dir("src")]
      if (query.startsWith("src/")) return [file("src/main.ts")]
      return []
    },
  })
  const { editor } = makeEditor(provider)

  typeText(editor, "@sr")
  await sleep(60)
  editor.handleInput("\r")
  assert.equal(editor.getText(), "@src/")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 5 })

  typeText(editor, "m")
  await sleep(60)
  assert.equal(queries.at(-1), "src/m")
  assert.equal(editor.isShowingAutocomplete(), true)
  editor.handleInput("\r")
  assert.equal(editor.getText(), "@src/main.ts ")
})

test("Esc closes the open @ menu and cancels the pending query that feeds it", async () => {
  const pending = new Map<string, (rows: readonly FileReferenceCandidate[]) => void>()
  const signals: AbortSignal[] = []
  const provider = makeProvider({
    fileReferences: async (query, signal) => {
      signals.push(signal)
      return await new Promise<readonly FileReferenceCandidate[]>((resolve) => {
        pending.set(query, resolve)
      })
    },
  })
  const { editor, payloads } = makeEditor(provider)

  // First query answers: the menu is up with the native rows.
  typeText(editor, "@a")
  await sleep(60)
  pending.get("a")?.([file("alpha.txt")])
  await sleep(20)
  assert.equal(editor.isShowingAutocomplete(), true)

  // Typing again starts a new query; Esc then closes the menu and aborts it.
  typeText(editor, "b")
  await sleep(60)
  press(editor, "\x1b")
  assert.equal(editor.isShowingAutocomplete(), false)
  assert.equal(signals.at(-1)?.aborted, true, "the pending native query is cancelled")

  // The cancelled domain answer cannot reopen the menu.
  pending.get("ab")?.([file("alpha-beta.txt")])
  await sleep(20)
  assert.equal(editor.isShowingAutocomplete(), false)
  assert.equal(editor.getText(), "@ab", "the draft is untouched")
  assert.equal(payloads.length, 0)
})

test("a stale answer for older text cannot replace the newer query's menu", async () => {
  const pending = new Map<string, (rows: readonly FileReferenceCandidate[]) => void>()
  const provider = makeProvider({
    fileReferences: async (query) =>
      await new Promise<readonly FileReferenceCandidate[]>((resolve) => {
        pending.set(query, resolve)
      }),
  })
  const { editor } = makeEditor(provider)

  typeText(editor, "@a")
  await sleep(60)
  pending.get("a")?.([file("old-a.txt")])
  await sleep(20)
  assert.equal(editor.isShowingAutocomplete(), true)

  // Typing cancels/retries; only the newest query may open the menu.
  typeText(editor, "b")
  await sleep(60)
  pending.get("ab")?.([file("new-ab.txt")])
  pending.get("a")?.([file("old-a.txt")])
  await sleep(20)

  const rendered = renderAt(editor, 80).join("\n")
  assert.ok(rendered.includes("new-ab.txt"), "the newest candidates are listed")
  assert.ok(!rendered.includes("old-a.txt"), "the stale answer is dropped")

  editor.handleInput("\r")
  assert.equal(editor.getText(), "@new-ab.txt ")
})

test("a rejected native query leaves the terminal draft clean and editable", async () => {
  const provider = makeProvider({
    fileReferences: async () => {
      throw new Error("native discovery failed")
    },
  })
  const { editor, payloads } = makeEditor(provider)

  typeText(editor, "hello @sr")
  await sleep(60)
  assert.equal(editor.isShowingAutocomplete(), false)
  assert.equal(editor.getText(), "hello @sr", "no diagnostic text is typed into the draft")

  typeText(editor, "c")
  assert.equal(editor.getText(), "hello @src")
  press(editor, "\x15") // Ctrl+U still edits
  assert.equal(editor.getText(), "")
  assert.equal(payloads.length, 0)
})

test("the native @ menu keeps undo, cursor and attachment registries on one editor", async () => {
  const provider = makeProvider({ fileReferences: async () => [file("notes.md")] })
  const { editor } = makeEditor(provider)

  const id = editor.insertImage({
    type: "image",
    mediaType: "image/png",
    data: Buffer.alloc(32, 7).toString("base64"),
    name: "shot.png",
  })
  // A marker directly against `@` is not a token boundary; the space makes it one.
  typeText(editor, " @not")
  await sleep(60)
  editor.handleInput("\r")
  assert.equal(editor.getText(), `[Image #${id}] @notes.md `)

  // The applied mention is one undo step on this editor state.
  press(editor, "\x1f") // Ctrl+_
  assert.equal(editor.getText(), `[Image #${id}] @not`)
  assert.deepEqual(
    editor.getImageAttachmentEntries().map(([key]) => key),
    [id],
  )
})

test("dispose keeps slash/file behavior and never resurrects a refresh", async () => {
  let refreshes = 0
  const provider = makeProvider({
    commands: [{ name: "help", description: "Display commands" }],
    fileReferences: async () => [file("alpha.txt")],
    refreshSkills: async () => {
      refreshes += 1
    },
  })
  assert.deepEqual(values(await suggest(provider, "@al")), ["@alpha.txt"])
  provider.dispose()
  provider.dispose()
  assert.deepEqual(values(await suggest(provider, "@al")), ["@alpha.txt"])
  assert.deepEqual(values(await suggest(provider, "/h")), ["help"])
  await sleep(0)
  assert.equal(refreshes, 0, "no refresh is started after dispose")
})
