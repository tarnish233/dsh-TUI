import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  asTui,
  createFakeTui,
  loadInputModule,
  renderAt,
  testEditorTheme,
  typeText,
} from "../src/input/testing/harness.ts"
import type { CcSubmitPayload } from "../src/input/index.ts"
import type { SkillCatalogEntry } from "../src/backend/types.ts"
import {
  CombinedAutocompleteProvider,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type SlashCommand,
} from "#pi-tui"

const mod = await loadInputModule()
type Provider = InstanceType<typeof mod.NativeAutocompleteProvider>

const noopSignal = () => new AbortController().signal

function makeProvider(options: {
  commands?: readonly SlashCommand[]
  skills?: readonly SkillCatalogEntry[]
  basePath?: string
  refreshSkills?: (signal: AbortSignal) => Promise<void>
}): Provider {
  return new mod.NativeAutocompleteProvider({
    commands: () => options.commands ?? [],
    skills: () => options.skills ?? [],
    basePath: options.basePath ?? process.cwd(),
    ...(options.refreshSkills ? { refreshSkills: options.refreshSkills } : {}),
  })
}

async function suggest(
  provider: Provider,
  text: string,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<AutocompleteSuggestions | null> {
  return await provider.getSuggestions([text], 0, text.length, {
    signal: options.signal ?? noopSignal(),
    ...(options.force === true ? { force: true } : {}),
  })
}

function skill(name: string, description: string, modelInvocable = true): SkillCatalogEntry {
  return { name, description, modelInvocable }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test("slash menu uses native /name skill metadata (no skill: alias, no /skill wrapper)", async () => {
  const provider = makeProvider({
    commands: [{ name: "help", description: "Display commands" }],
    skills: [skill("review", "Review the diff"), skill("deploy-docs", "Publish docs")],
  })

  const all = await suggest(provider, "/")
  assert.deepEqual(
    all?.items.map((item) => item.value),
    ["help", "review", "deploy-docs"],
  )
  assert.equal(all?.prefix, "/")
  for (const item of all?.items ?? []) {
    assert.equal(item.label, item.value, "labels are the native name, verbatim")
    assert.ok(!item.value.startsWith("skill:"))
    assert.ok(!item.value.includes(":"))
  }

  const filtered = await suggest(provider, "/rev")
  assert.deepEqual(
    filtered?.items.map((item) => item.value),
    ["review"],
  )
  assert.equal(filtered?.items[0]?.description, "Skill — Review the diff")

  const bySubsequence = await suggest(provider, "/dpd")
  assert.deepEqual(
    bySubsequence?.items.map((item) => item.value),
    ["deploy-docs"],
  )
  assert.equal(await suggest(provider, "/nope"), null)
})

test("commands keep native order and win a name collision with a skill", async () => {
  const provider = makeProvider({
    commands: [
      { name: "beta", description: "B" },
      { name: "alpha", description: "A" },
      { name: "review", description: "Native review command" },
    ],
    skills: [
      skill("zeta", "Z"),
      skill("review", "Skill review body"),
      skill("mango", "M"),
    ],
  })

  const result = await suggest(provider, "/")
  assert.deepEqual(
    result?.items.map((item) => item.value),
    ["beta", "alpha", "review", "zeta", "mango"],
  )
  const review = result?.items.find((item) => item.value === "review")
  assert.equal(review?.description, "Native review command")
  assert.equal(
    result?.items.filter((item) => item.value === "review").length,
    1,
    "a colliding skill never duplicates the command entry",
  )
})

test("user-only skills are labelled; model-invocable skills are not", async () => {
  const provider = makeProvider({
    skills: [skill("ask", "Ask a question", false), skill("review", "Review changes", true)],
  })
  const result = await suggest(provider, "/")
  const descriptions = Object.fromEntries((result?.items ?? []).map((item) => [item.value, item.description]))
  assert.equal(descriptions.ask, "Skill (user-only) — Ask a question")
  assert.equal(descriptions.review, "Skill — Review changes")
})

test("control characters in metadata cannot pollute the menu", async () => {
  const provider = makeProvider({
    commands: [{ name: "help", description: "safe\u001b[31mred\u001b[0m\nnext\tline\u0000end" }],
    skills: [{ name: "evil\u001b[2J", description: "desc\u2028sep\u2029end\u009b31m", modelInvocable: true }],
  })
  const result = await suggest(provider, "/")
  assert.equal(result?.items[0]?.description, "safered next line end")
  assert.equal(result?.items[0]?.value, "help")
  // A name carrying an escape sequence is sanitized back to its invocable form.
  assert.deepEqual(
    result?.items.map((item) => item.value),
    ["help", "evil"],
  )
  for (const item of result?.items ?? []) {
    for (const text of [item.label, item.description ?? ""]) {
      assert.ok(!/[\p{Cc}\u2028\u2029]/u.test(text), `control characters leaked: ${JSON.stringify(text)}`)
    }
  }

  // Names that cannot be invoked as /name are omitted instead of faked.
  const unusable = makeProvider({ skills: [skill("has space", "x"), skill("a/b", "y"), skill("ok", "z")] })
  assert.deepEqual(
    (await suggest(unusable, "/"))?.items.map((item) => item.value),
    ["ok"],
  )
})

test("skills are metadata only: no skill files are read or expanded", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "dsh-tui-skills-menu-"))
  try {
    const skillDir = path.join(cwd, ".dsh", "skills", "secret")
    await mkdir(skillDir, { recursive: true })
    await writeFile(path.join(skillDir, "SKILL.md"), "SECRET-SKILL-BODY do not render")
    await writeFile(path.join(cwd, "README.md"), "readme")

    const provider = makeProvider({
      basePath: cwd,
      skills: [skill("secret", "A public description")],
    })
    const menu = await suggest(provider, "/")
    const serialized = JSON.stringify(menu)
    assert.ok(!serialized.includes("SECRET-SKILL-BODY"))
    assert.equal(menu?.items.length, 1)
    assert.equal(menu?.items[0]?.description, "Skill — A public description")

    // Once in argument context, skill names get no fabricated expansion or
    // argument suggestions: Pi's combined provider finds no such command.
    assert.equal(await suggest(provider, "/secret "), null)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("file, @, argument and forced completion are delegated to Pi unchanged", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "dsh-tui-skills-delegate-"))
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
    let refreshCalls = 0
    const provider = makeProvider({
      commands,
      basePath: cwd,
      skills: [skill("review", "Review")],
      refreshSkills: async () => {
        refreshCalls += 1
      },
    })
    const reference = new CombinedAutocompleteProvider([...commands], cwd)

    const cases: Array<{ text: string; force?: boolean }> = [
      { text: "src/ma" },
      { text: "src/" },
      { text: "@alpha" },
      { text: "@src/ma" },
      { text: "/deploy st" },
      { text: "/set", force: true },
      { text: "/" , force: true },
      { text: "" , force: true },
    ]
    for (const item of cases) {
      const signal = noopSignal()
      const options = { signal, ...(item.force === true ? { force: true } : {}) }
      const actual = await provider.getSuggestions([item.text], 0, item.text.length, options)
      const expected = await reference.getSuggestions([item.text], 0, item.text.length, options)
      assert.deepEqual(actual, expected, `delegation mismatch for ${JSON.stringify(item)}`)
      assert.equal(refreshCalls, 0, "non-slash-name completion must not refresh skills")
    }

    // shouldTriggerFileCompletion keeps Pi's slash-name guard.
    assert.equal(provider.shouldTriggerFileCompletion(["/rev"], 0, 4), false)
    assert.equal(provider.shouldTriggerFileCompletion(["/deploy st"], 0, 10), true)
    assert.equal(provider.shouldTriggerFileCompletion(["src/ma"], 0, 6), true)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("applyCompletion keeps Pi's slash-name insertion and cursor semantics", async () => {
  const provider = makeProvider({ commands: [{ name: "review", description: "R" }] })
  const applied = provider.applyCompletion([" /rev"], 0, 5, { value: "review", label: "review" }, "/rev")
  // Pi places the cursor after the inserted trailing space (`/review ` = 9).
  assert.deepEqual(applied, { lines: [" /review "], cursorLine: 0, cursorCol: 9 })

  const slash = await suggest(provider, "/rev")
  assert.equal(slash?.prefix, "/rev")
  const withArgs = provider.applyCompletion(["/review a"], 0, 9, { value: "alpha", label: "alpha" }, "a")
  assert.deepEqual(withArgs.lines, ["/review alpha"])
})

test("slash menu appears immediately instead of waiting for the refresh", async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let signals: AbortSignal[] = []
  const provider = makeProvider({
    commands: [{ name: "help", description: "Display commands" }],
    skills: [skill("review", "Review changes")],
    refreshSkills: async (signal) => {
      signals.push(signal)
      await gate
    },
  })

  const pending = suggest(provider, "/rev")
  const result = await pending
  assert.deepEqual(
    result?.items.map((item) => item.value),
    ["review"],
    "current metadata is shown before the parent query settles",
  )
  assert.equal(provider.isRefreshingSkills(), true)
  assert.equal(signals.length, 1)

  release?.()
  await sleep(0)
  assert.equal(provider.isRefreshingSkills(), false)
  assert.equal(signals[0]?.aborted, false)
})

test("refresh is strictly single-flight while one parent call is pending", async () => {
  let calls = 0
  const pending: Array<() => void> = []
  const provider = makeProvider({
    commands: [{ name: "help", description: "Display commands" }],
    refreshSkills: async () => {
      calls += 1
      await new Promise<void>((resolve) => {
        pending.push(resolve)
      })
    },
  })

  // Keystrokes, the same menu re-triggered, and a background metadata re-query
  // while the first call is pending add no second fetch.
  await suggest(provider, "/")
  await suggest(provider, "/")
  await suggest(provider, "/h")
  await suggest(provider, "/")
  assert.equal(calls, 1, "in-flight refresh is coalesced across keystrokes and re-triggers")

  pending.shift()?.()
  await sleep(0)
  assert.equal(provider.isRefreshingSkills(), false)

  // Parent owns catalog validity: a later regular slash query (even the exact
  // same text) may ask again instead of being memoized forever.
  await suggest(provider, "/")
  assert.equal(calls, 2, "a settled query is not memoized; the parent cache decides freshness")
  pending.shift()?.()
  await sleep(0)
  await suggest(provider, "/")
  assert.equal(calls, 3)
  pending.shift()?.()
  await sleep(0)
})

test("a failing refresh stays retryable for the exact same slash prefix", async () => {
  let calls = 0
  const provider = makeProvider({
    commands: [{ name: "help", description: "Display commands" }],
    refreshSkills: async () => {
      calls += 1
      throw new Error("native discovery unavailable")
    },
  })

  assert.deepEqual((await suggest(provider, "/rev"))?.items.map((item) => item.value), undefined)
  await sleep(0)
  assert.equal(calls, 1)
  assert.deepEqual((await suggest(provider, "/rev"))?.items.map((item) => item.value), undefined)
  await sleep(0)
  assert.equal(calls, 2, "rejection must not permanently suppress the same-prefix retry")
  assert.deepEqual((await suggest(provider, "/rev"))?.items.map((item) => item.value), undefined)
  await sleep(0)
  assert.equal(calls, 3)
  assert.equal(provider.isRefreshingSkills(), false)
})

test("same prefix after a scope invalidation refetches and shows the new catalog", async () => {
  let scope: "alpha" | "beta" = "alpha"
  let calls = 0
  const provider = new mod.NativeAutocompleteProvider({
    commands: () => [{ name: "help", description: "Display commands" }],
    skills: () =>
      scope === "alpha"
        ? [skill("alpha-only", "Alpha scope")]
        : [skill("beta-only", "Beta scope")],
    basePath: process.cwd(),
    refreshSkills: async () => {
      calls += 1
    },
  })

  assert.deepEqual((await suggest(provider, "/"))?.items.map((item) => item.value), [
    "help",
    "alpha-only",
  ])
  await sleep(0)

  // The App invalidates the catalog for the new attachment/scope; the same
  // prefix must be able to fetch and read the new snapshot.
  scope = "beta"
  assert.deepEqual((await suggest(provider, "/"))?.items.map((item) => item.value), [
    "help",
    "beta-only",
  ])
  await sleep(0)
  assert.equal(calls, 2)
})

test("a genuine next query while the parent is still dirty starts no second fetch", async () => {
  let calls = 0
  const pending: Array<() => void> = []
  const provider = makeProvider({
    commands: [{ name: "help", description: "Display commands" }],
    refreshSkills: async () => {
      calls += 1
      await new Promise<void>((resolve) => {
        pending.push(resolve)
      })
    },
  })

  await suggest(provider, "/")
  assert.equal(calls, 1)
  // Typing the next character is a genuine new query, but the dirty parent call
  // is still in flight: single-flight keeps exactly one fetch.
  await suggest(provider, "/h")
  await suggest(provider, "/he")
  assert.equal(calls, 1)
  assert.equal(provider.isRefreshingSkills(), true)

  pending.shift()?.()
  await sleep(0)
  await suggest(provider, "/hel")
  assert.equal(calls, 2)
  pending.shift()?.()
  await sleep(0)
})

test("refresh rejection and late catalogs never break existing completions", async () => {
  const skills: SkillCatalogEntry[] = []
  let attempts = 0
  const provider = makeProvider({
    commands: [{ name: "help", description: "Display commands" }],
    skills: [],
    refreshSkills: async () => {
      attempts += 1
      throw new Error("native skill discovery failed")
    },
  })
  // Use the mutable catalog after construction.
  const live = new mod.NativeAutocompleteProvider({
    commands: () => [{ name: "help", description: "Display commands" }],
    skills: () => skills,
    basePath: process.cwd(),
    refreshSkills: async () => {
      attempts += 1
      throw new Error("native skill discovery failed")
    },
  })

  const before = await suggest(live, "/rev")
  assert.equal(before, null)
  await sleep(0)
  assert.equal(attempts, 1)

  // A late catalog arrives through the getter: no cached state to invalidate.
  skills.push(skill("review", "Review changes"))
  const after = await suggest(live, "/rev")
  assert.deepEqual(
    after?.items.map((item) => item.value),
    ["review"],
  )

  // Human commands remain available when the skill refresh keeps failing.
  const menu = await suggest(live, "/")
  assert.deepEqual(
    menu?.items.map((item) => item.value),
    ["help", "review"],
  )
  assert.equal(attempts, 3, "each genuine slash query retries after failures")

  // A throwing skills getter is treated as "no skills", not a crash.
  const broken = new mod.NativeAutocompleteProvider({
    commands: () => [{ name: "help", description: "Display commands" }],
    skills: () => {
      throw new Error("no viewing agent")
    },
    basePath: process.cwd(),
  })
  assert.deepEqual(
    (await suggest(broken, "/"))?.items.map((item) => item.value),
    ["help"],
  )
  assert.equal(provider.isRefreshingSkills(), false)
})

test("dispose aborts the parent refresh and stops starting new ones", async () => {
  const signals: AbortSignal[] = []
  let calls = 0
  const provider = makeProvider({
    commands: [{ name: "help", description: "Display commands" }],
    refreshSkills: async (signal) => {
      calls += 1
      signals.push(signal)
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
        setTimeout(resolve, 50)
      })
    },
  })

  assert.equal((await suggest(provider, "/"))?.items.length, 1)
  assert.equal(calls, 1)
  provider.dispose()
  provider.dispose() // idempotent
  assert.equal(signals[0]?.aborted, true)
  await sleep(10)
  assert.equal(provider.isRefreshingSkills(), false)

  // No resurrected background request after disposal; suggestions still work.
  assert.equal((await suggest(provider, "/h"))?.items.length, 1)
  assert.equal(calls, 1)
})

test("last behavior: aborting a suggestion request does not abort the refresh query", async () => {
  let refreshSignal: AbortSignal | undefined
  const provider = makeProvider({
    commands: [{ name: "help", description: "Display commands" }],
    refreshSkills: async (signal) => {
      refreshSignal = signal
      await new Promise<void>(() => {})
    },
  })
  const controller = new AbortController()
  const result = await provider.getSuggestions(["/h"], 0, 2, { signal: controller.signal })
  assert.equal(result?.items.length, 1)
  controller.abort()
  assert.equal(refreshSignal?.aborted, false, "keystroke cancellation is not a catalog cancellation")
  provider.dispose()
  assert.equal(refreshSignal?.aborted, true)
})

// --- CcEditor integration -------------------------------------------------

function makeEditor(provider: AutocompleteProvider) {
  const tui = createFakeTui()
  const editor = new mod.CcEditor(asTui(tui), testEditorTheme)
  editor.setAutocompleteProvider(provider)
  renderAt(editor, 80)
  return editor
}

function makeContentEditor(provider: AutocompleteProvider) {
  const editor = makeEditor(provider)
  const payloads: CcSubmitPayload[] = []
  const blocked: Error[] = []
  const legacy: string[] = []
  editor.onSubmitContent = (payload) => payloads.push(payload)
  editor.onSubmitBlocked = (error) => blocked.push(error)
  editor.onSubmit = (text) => legacy.push(text)
  return { editor, payloads, blocked, legacy }
}

function upload(id: number) {
  return {
    type: "image" as const,
    mediaType: "image/png" as const,
    data: Buffer.alloc(32, id).toString("base64"),
    name: `shot-${id}.png`,
  }
}

function oldTextField(text: string): string {
  return text.trim()
}


test("CcEditor content path: Enter submits the accepted slash name, not the typed prefix", async () => {
  const provider = makeProvider({
    commands: [{ name: "help", description: "Display commands" }],
    skills: [skill("review", "Review changes")],
  })
  const { editor, payloads, legacy, blocked } = makeContentEditor(provider)

  typeText(editor, "/rev")
  await sleep(20)
  assert.equal(editor.isShowingAutocomplete(), true)
  assert.equal(payloads.length, 0, "typing does not capture or submit")

  editor.handleInput("\r")
  assert.equal(payloads.length, 1, "onSubmitContent receives exactly one payload")
  assert.equal(legacy.length, 0, "the legacy text callback is not also fired")
  assert.equal(blocked.length, 0)

  const payload = payloads[0]!
  // The applied candidate is captured immediately before Pi clears the draft.
  assert.equal(payload.text, "/review")
  assert.equal(payload.content.length, 1)
  assert.equal(payload.content[0]?.type, "text")
  assert.equal(oldTextField(payload.content[0]!.type === "text" ? payload.content[0].text : ""), "/review")
  assert.deepEqual(payload.snapshot.lines, ["/review "], "snapshot holds the completed draft")
  assert.equal(payload.snapshot.text, "/review ")
  assert.deepEqual(payload.images, [])
  assert.equal(editor.getText(), "", "the draft cleared after the capture")

  // A rejected native admission restores the completed draft, not "/rev".
  editor.restoreDraft(payload.snapshot)
  assert.equal(editor.getText(), "/review ")
  assert.equal(payloads.length, 1, "Enter consumed the key exactly once")
})

test("CcEditor content path: a native command completion submits the same way", async () => {
  const provider = makeProvider({ commands: [{ name: "settings", description: "TUI preferences" }] })
  const { editor, payloads, legacy } = makeContentEditor(provider)

  typeText(editor, "/set")
  await sleep(20)
  assert.equal(editor.isShowingAutocomplete(), true)
  editor.handleInput("\r")

  assert.equal(payloads.length, 1)
  assert.equal(legacy.length, 0)
  assert.equal(payloads[0]?.text, "/settings")
  assert.deepEqual(payloads[0]?.snapshot.lines, ["/settings "])
})

test("CcEditor content path: the selected non-first candidate is what gets submitted", async () => {
  const provider = makeProvider({
    commands: [{ name: "help", description: "Display commands" }],
    skills: [skill("review", "Review changes"), skill("deploy", "Deploy it")],
  })
  const { editor, payloads } = makeContentEditor(provider)

  typeText(editor, "/")
  await sleep(20)
  assert.equal(editor.isShowingAutocomplete(), true)
  editor.handleInput("\x0e") // Ctrl+N: help -> review
  editor.handleInput("\r")

  assert.equal(payloads.length, 1)
  assert.equal(payloads[0]?.text, "/review")
  assert.deepEqual(payloads[0]?.snapshot.lines, ["/review "])
})

test("CcEditor content path: rejected admission keeps the completed image-bearing draft", async () => {
  const provider = makeProvider({ skills: [skill("review", "Review changes")] })
  const { editor, payloads, blocked } = makeContentEditor(provider)

  const id = editor.insertImage(upload(1))
  // The completion context only inspects the text before the cursor.
  editor.setText(`/rev [Image #${id}]`)
  editor.ccSetCursor(0, 4)
  renderAt(editor, 80)
  editor.ccTriggerCompletion() // Tab-style open: explicit but not forced/auto-accepted
  await sleep(20)
  assert.equal(editor.isShowingAutocomplete(), true)

  editor.handleInput("\r")
  assert.equal(blocked.length, 0)
  assert.equal(payloads.length, 1)
  const payload = payloads[0]!
  assert.equal(payload.text, `/review  [Image #${id}]`)
  assert.deepEqual(
    payload.content.map((part) => part.type),
    ["text", "image"],
    "ordered native prompt parts survive the accept-then-capture path",
  )
  assert.equal(payload.images.length, 1)
  assert.equal(payload.snapshot.imageAttachments.length, 1)
  assert.ok(payload.snapshot.text.startsWith("/review"), "snapshot is the completed draft")
  assert.ok(payload.snapshot.text.includes(`[Image #${id}]`))

  // Native admission failed: the App restores the captured pre-clear snapshot.
  editor.restoreDraft(payload.snapshot)
  assert.equal(editor.getText(), `/review  [Image #${id}]`)
  assert.equal(editor.hasImageAttachments(), true)
  assert.ok(!editor.getText().startsWith("/rev ["))
})

test("CcEditor content path: file completion Enter stays fill-only and never submits image content", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "dsh-tui-skills-file-enter-"))
  try {
    await mkdir(path.join(cwd, "src"), { recursive: true })
    await writeFile(path.join(cwd, "src", "main.ts"), "")
    await writeFile(path.join(cwd, "src", "map.ts"), "")

    const provider = makeProvider({ commands: [{ name: "help", description: "Display commands" }], basePath: cwd })
    const { editor, payloads, blocked } = makeContentEditor(provider)
    const id = editor.insertImage(upload(1))
    editor.setText(`[Image #${id}] src/ma`)
    renderAt(editor, 80)

    editor.handleInput("\t") // explicit file completion (two candidates -> menu)
    await sleep(20)
    assert.equal(editor.isShowingAutocomplete(), true)
    editor.handleInput("\r") // Enter accepts the path only

    assert.equal(editor.getText(), `[Image #${id}] src/main.ts`)
    assert.equal(payloads.length, 0, "file completion Enter must not submit")
    assert.equal(blocked.length, 0, "and must not validate/send image content")
    assert.equal(editor.hasImageAttachments(), true)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("CcEditor: the direct seam confirm keeps its default submitValue behavior", async () => {
  const submitted: string[] = []
  const provider = makeProvider({ skills: [skill("review", "Review changes")] })
  const editor = makeEditor(provider)
  editor.onSubmit = (text) => submitted.push(text)

  typeText(editor, "/rev")
  await sleep(20)
  editor.ccAutocompleteAccept("confirm")
  assert.deepEqual(submitted, ["/review"])
  assert.equal(editor.getText(), "")
})

test("CcEditor content path: Tab still edits only, and a remapped accept still submits once", async () => {
  const provider = makeProvider({ skills: [skill("review", "Review changes")] })
  const { editor, payloads } = makeContentEditor(provider)

  typeText(editor, "/rev")
  await sleep(20)
  editor.handleInput("\t")
  assert.equal(editor.getText(), "/review ")
  assert.equal(payloads.length, 0, "Tab only edits the draft")

  editor.setText("")
  editor.setBindings({ "autocomplete.accept": ["ctrl+y"] })
  typeText(editor, "/rev")
  await sleep(20)
  assert.equal(editor.isShowingAutocomplete(), true)
  // Enter is no longer the accept key: it keeps its existing submit fallback
  // (raw draft), and the content-aware accept path is not involved.
  editor.handleInput("\r")
  assert.equal(payloads.length, 1)
  assert.equal(payloads[0]?.text, "/rev")

  typeText(editor, "/rev")
  await sleep(20)
  assert.equal(editor.isShowingAutocomplete(), true)
  editor.handleInput("\x19") // Ctrl+Y is the configured accept key (Tab path)
  assert.equal(editor.getText(), "/review ")
  assert.equal(payloads.length, 1, "Tab-style accept never submits")
})

test("CcEditor: Tab accepts a native /name completion; Enter submits the raw text", async () => {
  const submitted: string[] = []
  const provider = makeProvider({
    commands: [{ name: "help", description: "Display commands" }],
    skills: [skill("review", "Review changes")],
  })
  const editor = makeEditor(provider)
  editor.onSubmit = (text) => {
    submitted.push(text)
  }

  typeText(editor, "/rev")
  await sleep(20)
  assert.equal(editor.isShowingAutocomplete(), true)
  editor.handleInput("\t")
  assert.equal(editor.getText(), "/review ")
  assert.deepEqual(submitted, [], "Tab accepts into the draft, it never submits")

  // Enter submits the plain text draft through Pi's normal submit path.
  // Pi trims the submitted draft; the input layer submits plain text only.
  editor.handleInput("\r")
  assert.deepEqual(submitted, ["/review"])
  assert.equal(editor.getText(), "")
})

test("CcEditor: Enter accepts-and-submits the raw slash text; no skill body is expanded", async () => {
  const submitted: string[] = []
  const provider = makeProvider({
    commands: [{ name: "help", description: "Display commands" }],
    skills: [skill("review", "Review changes")],
  })
  const editor = makeEditor(provider)
  editor.onSubmit = (text) => {
    submitted.push(text)
  }

  typeText(editor, "/rev")
  await sleep(20)
  assert.equal(editor.isShowingAutocomplete(), true)
  editor.handleInput("\r")
  assert.deepEqual(submitted, ["/review"], "input layer submits text; the App routes the command")
  assert.equal(editor.isShowingAutocomplete(), false)
})

test("ccRefreshAutocomplete re-reads metadata without applying or submitting", async () => {
  const submitted: string[] = []
  const skills: SkillCatalogEntry[] = []
  const provider = new mod.NativeAutocompleteProvider({
    commands: () => [{ name: "help", description: "Display commands" }],
    skills: () => skills,
    basePath: process.cwd(),
  })
  const editor = makeEditor(provider)
  editor.onSubmit = (text) => {
    submitted.push(text)
  }

  typeText(editor, "/rev")
  await sleep(20)
  assert.equal(editor.isShowingAutocomplete(), false, "nothing matches before metadata arrives")
  assert.equal(editor.getText(), "/rev")

  // A single late candidate must never be auto-applied by a background refresh.
  skills.push(skill("review", "Review changes"))
  editor.ccRefreshAutocomplete()
  await sleep(20)
  assert.equal(editor.isShowingAutocomplete(), true)
  assert.equal(editor.getText(), "/rev", "refresh only repaints candidates")
  assert.deepEqual(submitted, [])
  assert.equal(editor.getText(), "/rev")

  // Esc closes the menu and the draft is untouched; the App scopes/tombstones
  // further refreshes, the seam itself performs no resurrection.
  editor.handleInput("\x1b")
  assert.equal(editor.isShowingAutocomplete(), false)
  assert.equal(editor.getText(), "/rev")
  assert.deepEqual(submitted, [])
})

test("background metadata requery while the first refresh is in flight adds no fetch and never auto-applies", async () => {
  const submitted: string[] = []
  const skills: SkillCatalogEntry[] = []
  let calls = 0
  let release: (() => void) | undefined
  const provider = new mod.NativeAutocompleteProvider({
    commands: () => [{ name: "help", description: "Display commands" }],
    skills: () => skills,
    basePath: process.cwd(),
    refreshSkills: async () => {
      calls += 1
      await new Promise<void>((resolve) => {
        release = resolve
      })
    },
  })
  const editor = makeEditor(provider)
  editor.onSubmit = (text) => {
    submitted.push(text)
  }

  typeText(editor, "/rev")
  await sleep(20)
  assert.equal(calls, 1, "typing the slash name is one parent query")
  assert.equal(editor.isShowingAutocomplete(), false)

  // Metadata arrives while the parent call is still pending. The background
  // re-query (what the App does when metadata settles) shows the lone candidate
  // without starting another fetch, applying it or submitting.
  skills.push(skill("review", "Review changes"))
  editor.ccRefreshAutocomplete()
  editor.ccRefreshAutocomplete()
  await sleep(20)
  assert.equal(calls, 1, "in-flight refresh suppresses the background refetch")
  assert.equal(editor.isShowingAutocomplete(), true)
  assert.equal(editor.getText(), "/rev")
  assert.deepEqual(submitted, [])

  release?.()
  await sleep(0)
  assert.equal(editor.getText(), "/rev", "a settled parent call never auto-applies")
  assert.deepEqual(submitted, [])
  assert.equal(editor.isShowingAutocomplete(), true)

  // Explicit acceptance is still the only apply path.
  editor.handleInput("\t")
  assert.equal(editor.getText(), "/review ")
  assert.deepEqual(submitted, [])
})

test("ccRefreshAutocomplete is a no-op without an open menu state change or provider", async () => {
  const editor = makeEditor(makeProvider({ commands: [{ name: "help", description: "Display commands" }] }))
  typeText(editor, "plain text")
  editor.ccRefreshAutocomplete()
  await sleep(20)
  assert.equal(editor.getText(), "plain text")
  assert.equal(editor.isShowingAutocomplete(), false)
})

test("kill/yank/undo and image drafts are unaffected by slash completion refresh", async () => {
  const tui = createFakeTui()
  const skills: SkillCatalogEntry[] = []
  const provider = new mod.NativeAutocompleteProvider({
    commands: () => [{ name: "help", description: "Display commands" }],
    skills: () => skills,
    basePath: process.cwd(),
  })
  const editor = new mod.CcEditor(asTui(tui), testEditorTheme)
  editor.setAutocompleteProvider(provider)
  renderAt(editor, 80)

  const image = { type: "image", mediaType: "image/png", data: Buffer.from([1, 2, 3]).toString("base64") } as const
  const id = editor.insertImage(image)
  editor.setText(`draft [Image #${id}]`)
  typeText(editor, " tail")
  assert.deepEqual(editor.getImageAttachments().map((entry: { id: number }) => entry.id), [id])

  editor.handleInput("\x17") // Ctrl+W kills "tail"
  assert.equal(editor.getText(), `draft [Image #${id}] `)
  editor.handleInput("\x19") // Ctrl+Y restores it
  assert.equal(editor.getText(), `draft [Image #${id}] tail`)

  // Metadata settling mid-draft still leaves undo/attachments intact.
  skills.push(skill("review", "Review changes"))
  editor.ccRefreshAutocomplete()
  await sleep(20)
  assert.equal(editor.getText(), `draft [Image #${id}] tail`)
  assert.equal(editor.hasImageAttachments(), true)

  editor.handleInput("\x1f") // Ctrl+_ undoes the yank
  assert.equal(editor.getText(), `draft [Image #${id}] `)
  editor.handleInput("\x1f") // undo the kill
  assert.equal(editor.getText(), `draft [Image #${id}] tail`)
  assert.deepEqual(editor.getImageAttachments().map((entry: { id: number }) => entry.id), [id])
})