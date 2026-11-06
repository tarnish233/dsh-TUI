// Application identity regression for the input-owned surface.
//
// The user requires one complete rename: the retired dsh+pi identity spellings
// (package, service, class and env-var composites) become dsh-tui / dshTui /
// DshTui / DSH_TUI. This test guards the files the input developer owns
// (src/input, vendor/pi-tui attribution, test/input*.test.ts and the input
// docs) so a stale identity cannot creep back in through a module header,
// diagnostic or fixture.
//
// It deliberately does NOT rename upstream Pi TUI: `@earendil-works/pi-tui`,
// `vendor/pi-tui`, the private `#pi-tui` seam and the "Pi TUI" attribution keep
// their real upstream names. A vendored refresh must stay recognisably Pi's
// package, not ours.
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const SRC = join(ROOT, "src")
const TEST = join(ROOT, "test")
const VENDOR = join(ROOT, "vendor", "pi-tui")

/**
 * Retired composite identity spellings, assembled from parts so this guard does
 * not contain the very literals it forbids. `pi-tui` alone stays a valid
 * upstream name.
 */
const RETIRED = ["dsh" + "-pi-tui", "dsh" + "PiTui", "Dsh" + "PiTui", "DSH" + "_PI_TUI"] as const

function files(directory: string, accept: (name: string) => boolean): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue
    const full = join(directory, entry.name)
    if (entry.isDirectory()) { found.push(...files(full, accept)); continue }
    if (entry.isFile() && accept(entry.name)) found.push(full)
  }
  return found
}

const isSource = (name: string): boolean => /\.(?:ts|js|mjs)$/.test(name)

const inputSources = (): string[] => files(join(SRC, "input"), isSource)
const inputTests = (): string[] => readdirSync(TEST)
  .filter(name => /^input.*\.test\.ts$/.test(name))
  .map(name => join(TEST, name))
const inputDocs = (): string[] => readdirSync(join(ROOT, "docs"))
  .filter(name => /^(?:INPUT.*|MODEL-INPUT-API)\.md$/.test(name))
  .map(name => join(ROOT, "docs", name))
/** Our local vendor notes plus upstream sources; the generated dist is ignored. */
const vendorSubjects = (): string[] => [
  join(VENDOR, "SOURCE.md"),
  join(VENDOR, "package.json"),
  ...files(join(VENDOR, "src"), isSource),
]

test("input sources, tests, docs and vendor notes carry no retired application identity", () => {
  const subject = [...inputSources(), ...inputTests(), ...inputDocs(), ...vendorSubjects()]
  assert.ok(inputSources().length >= 8, "the source walk actually covers src/input")
  assert.ok(inputTests().length >= 8, "the test walk covers the input suite")
  assert.ok(inputDocs().length >= 3, "the doc walk covers INPUT*, INPUT-LIFECYCLE and MODEL-INPUT-API")
  for (const file of subject) {
    const source = readFileSync(file, "utf8")
    for (const retired of RETIRED) {
      assert.ok(!source.includes(retired), `${file.slice(ROOT.length)} still uses the retired identity ${retired}`)
    }
  }
})

test("vendored Pi TUI keeps its upstream package identity and the #pi-tui seam", () => {
  const manifest = JSON.parse(readFileSync(join(VENDOR, "package.json"), "utf8")) as { name?: unknown }
  assert.equal(manifest.name, "@earendil-works/pi-tui", "the vendored package must stay the real upstream Pi TUI package")
  const source = readFileSync(join(VENDOR, "SOURCE.md"), "utf8")
  assert.match(source, /@earendil-works\/pi-tui/)
  assert.match(source, /#pi-tui/)

  // Input modules reach Pi TUI only through the private package-import seam.
  const directImport = /from\s+["'](?:@earendil-works\/pi-tui|pi-tui)(?:\/[^"']*)?["']|from\s+["'][^"']*vendor\/pi-tui/
  for (const file of inputSources()) {
    const text = readFileSync(file, "utf8")
    assert.doesNotMatch(text, directImport, `${file.slice(ROOT.length)} bypasses the #pi-tui seam`)
  }
  const seamUsers = inputSources().filter(file => /from\s+['"]#pi-tui/.test(readFileSync(file, "utf8")))
  assert.ok(seamUsers.length > 0, "at least one input module imports the vendored Pi TUI through #pi-tui")
})