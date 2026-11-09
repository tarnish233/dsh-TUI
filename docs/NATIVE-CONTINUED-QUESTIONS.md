# Native timed / continued questions and late answers

Verified installation: `@deepseek-ai/dsh@0.2.2-rc.1` (public `.d.ts` and shipped
implementation under the installed `@deepseek-ai/*` tree, read-only). This
document describes `src/backend/native-questions.ts`. It adds no shared
contract, service, store, timer, fold or RPC surface: DSH owns the question
lifecycle and this adapter is one projection read plus one public write.

## Ownership boundary

DSH owns every fact:

| fact | owner |
| --- | --- |
| whether `ask_user_question` is blocking or timed | native tool row (`dsh-tool-ask-user` config) |
| the foreground deadline, its timer, client claims | `UserQuestionService` / `TimedQuestionWait` |
| which timed calls remain answerable, and which settled | native `userQuestions` session projection |
| whether a late reply is queued | native durable inbox projection |
| who may answer a continued question | `UserQuestionService.answer` live-root check |
| recording the late reply as a user turn | DSH (`user-question-reply` message source) |

The adapter never creates or resumes an Agent, folds session events, keeps a
pending-answer map, buffers a reply after a dialog closes, schedules a timeout,
or persists question state. It is not a second `PendingDecision` table: the
existing blocking decision path in `src/backend/context.ts` is unchanged, and a
blocking `ask_user_question` call can never be converted into a continued one.

## Native surface actually used

### Read: `ctx.sessionProjections.snapshot(session, keys)`

The registry (`@deepseek-ai/dsh-session-projection`) owns the fold, the
watermark cache and the change feed. The adapter asks for one consistent cut:

```ts
const { asOfSeq, values } = ctx.sessionProjections.snapshot(session, ['userQuestions', 'inbox'])
```

`values.userQuestions` is the wire view of the unit registered by
`UserQuestionService` (`@deepseek-ai/dsh-user-questions`):

```ts
{
  active: {
    callId: string                 // native ToolCallId
    state: 'open' | 'continued'
    questions: {
      id: string
      question: string
      header?: string
      options?: { label: string; description?: string }[]
      multiSelect?: boolean
    }[]
  }[]
  settled: { callId: string; answers: { id: string; selected: string[]; custom?: string }[] }[]
}
```

The fold is gated by the logged `request/header` tool schema: only calls made
while the timed `ask_user_question` schema was in effect are tracked (its
`timeout` parameter is the discriminator). A blocking legacy call appears in
neither list, so this view cannot mislabel a blocking decision.

`values.inbox` (`@deepseek-ai/dsh-agent-loop/inbox`:

```ts
{ 'next-turn': UserMessage[]; 'next-step': UserMessage[] }
```

is consulted only for `source.kind === 'user-question-reply'` and
`source.callId`, which is exactly the annotation "a reply is already queued".

The adapter requests both keys in **one** call so the queued annotation and the
question state come from the same `asOfSeq`. A missing `values.userQuestions`
means the unit is not registered (or the host does not mount
`sessionProjections`); the adapter then reports `available: false` rather than
an authoritative empty list.

### Write: `ctx.userQuestions.answer(agent, callId, answer)`

```ts
answer(agent: Agent, callId: ToolCallId, answer: { answers: { id, selected, custom? }[] }): boolean
```

- returns `true` when the reply was accepted and steered into the Agent as a
  `user-question-reply` user message (it stays queued until the Agent admits
  it), `false` when the call is no longer continued;
- calls `assertLiveRoot(agent)` first: the supplied Agent must be the registry's
  exact live instance and a runtime root. A non-live or delegated caller is
  rejected with `CALLER_NOT_LIVE` / `DELEGATED_CALLER`;
- rejects `REPLY_QUEUED` when a reply is already waiting for admission and
  `BAD_ANSWER` when the batch does not name each question of the call exactly
  once;
- persists nothing itself: the admitted user message is the durable record that
  closes the question in the projection.

The adapter passes the exact `NativeUiScope.agent` unchanged and maps those
public codes; it does not copy the service's root rule.

### `attachWait` — researched, deliberately not claimed

```ts
attachWait(agent: Agent, callId: ToolCallId, signal: AbortSignal): AsyncIterable<{ remainingMs: number }>
```

It lets one answer UI hold a **live foreground** timed wait: the stream yields
one host-computed remaining duration and ends when the claim or wait closes.
`askTimed` removes its wait in `finally`, so a continued call yields no frames.
Holding the countdown for an `open` question belongs to the blocking
`user-questions/request` answerer, which this task keeps unchanged. The adapter
therefore never calls `attachWait` (tests assert that), and no claim is leaked.

### No other native face

The service exposes exactly two Remote methods (`userQuestions/answer`,
`userQuestions/attachWait`). There is **no** public list/get RPC for pending
questions; the projection is the list face. Adding an RPC controller, a
`ctx.remote` call or a client-side fold would be a second answer store and is
not done here.

## Adapter API

```ts
export const USER_QUESTION_PROJECTION_KEYS = ['userQuestions', 'inbox'] as const
export function isUserQuestionProjectionKey(key: string): boolean

export class NativeQuestionAdapter {
  constructor(options: { access: NativeUiAccess })
  capabilities(): { list: boolean; answer: boolean }
  read(scope?: NativeUiScope): ContinuedQuestionsView | undefined
  answer(input: { callId: string; answer: unknown }, scope?: NativeUiScope): Promise<ContinuedAnswerResult>
}
```

`read` is synchronous and read-only. It never consults `agents` or `sessions`,
so discovery cannot materialize an Agent. `undefined` means there is no current
attachment; `available: false` means this exact attachment has no readable
native question state (a pending, Agent-less session included) and is
deliberately not reported as "no pending questions".

`capabilities()` reports the mounted public faces (`answer` implies `list`).
The parent can advertise a `continued-questions` capability from it.

`answer` returns one of four outcomes instead of inventing session state:

| outcome | native fact |
| --- | --- |
| `accepted` | `answer` returned `true`; the reply is queued until admission |
| `queued` | `REPLY_QUEUED`: a reply is already waiting for admission |
| `unavailable` | `answer` returned `false`, or the projection no longer lists a continued call, or the row is still `open` (the blocking waterfall owns it) |
| `stale` | attachment identity changed before or after the write; drop the dialog, never retry |

Throws only for `CAPABILITY_UNAVAILABLE` (no native answer face/projection,
no exact live root Agent), `INVALID_ARGUMENT` / `INVALID_ANSWER` (caller
mistake), or a redacted `RUNTIME_REQUEST_FAILED` for an unclassified native
failure. Warnings are bounded to eight distinct redacted messages and never
carry a native object, stack or credential.

### Attachment identity

The seam's exact scope object is validated and passed to `isCurrent` unchanged,
so a host that compares its own object still works. `read` refuses a supplied
`session` whose `id` is not the scope's `sessionId` instead of projecting the
wrong session. `answer` checks identity before the write (no submission after an
attachment replacement) and again after it; a replacement during a synchronous
steer is reported `stale` and is never retried.

### Answer encoding (native meaning preserved)

`answer` accepts the existing `DecisionDialog` value, one entry per native
question in ask order:

```ts
{ answers: (string | string[])[] }   // '' or [] = that question's native skip
```

or an already-native batch:

```ts
{ answers: { id: string; selected: string[]; custom?: string }[] }
```

Normalization preserves DSH's vocabulary:

- a string equal to a declared option label is `selected`; anything else in the
  positional form is free-form `custom` (never a fabricated label);
- a question with no declared options reports typed text as `custom` with empty
  `selected`;
- single-select: a custom answer overrides the choice (`selected: []`), and more
  than one selected label is refused;
- multi-select: selected labels keep the caller's order (deduplicated) and
  custom text supplements them;
- the native batch form must name each question exactly once and may only
  select labels the question actually declares;
- an empty string/list is a skip (`{id, selected: []}`), which DSH tells the
  model to read as "the user skipped this question", not as permission;
- `{cancelled: true}` is refused: a continued question has no native
  cancellation. Closing the panel must send nothing.

## Timeout outcome is preserved

For a timed call, `askTimed` closes `TimedQuestionWait` at the deadline (or a
client rejects `ASK_TIMED_OUT` first) and maps that to `{pending: true,
callId}`. The tool result records the timeout, which is what makes the
projection row `continued`. Consequences the adapter respects:

- the original `user-questions/request` waterfall has already settled; the
  adapter never resolves or rejects it and adds no pending entry;
- a late answer is a **new user message**, not a rewrite of the finished tool
  result;
- the projection's `settled` row for that call carries the batch the late reply
  recorded, because its own tool result only records the timeout.

For the parent's dialog: if `respond(id, …)` races a native timeout, DSH's
own `STALE_DECISION` is the correct answer. Re-read `read()` afterwards; when
the call is `continued`, offer the late path instead of settling the dead
request.

## Capability boundaries (upstream, not unfinished TUI work)

1. **No public pending-question list RPC.** Only the projection exists. A TUI
   that needs the list reads the projection; anything else would be an invented
   controller.
2. **No public way to abandon a continued question.** Closing a panel persists
   and sends nothing; only an answer batch settles it. The TUI must not fake a
   cancellation or hide a reply.
3. **The timed tool is opt-in.** `dsh-base` mounts `tool-ask-user` with the
   default `mode: 'legacy'` (blocking). Continued rows exist only when a profile
   mounts it as `mode: 'timed'`; with the legacy schema every call appears in
   neither projection half.
4. **No `intent`/`detail` in the projection vocabulary.** The tool arguments and
   the projection view carry `id/question/header/options/multiSelect` only, so
   plan-review and approval intents are inherently blocking-only (an `approval`
   intent also rejects any `wait`). The adapter never synthesizes an intent.
5. **Foreground `attachWait` claims are not this adapter's job.** They belong to
   the live blocking answerer; claiming an `open` wait here would be a second
   answer path.
6. **Inbox projection absence** makes `replyQueued` unknown (omitted). Native
   `answer` still refuses with `REPLY_QUEUED`, mapped to `queued`.
7. **Queued replies are dismissed by DSH, not the TUI.** If a queued reply is
   discarded, the only observable change is the durable inbox; the parent may
   invalidate the questions domain on `inbox` changes to re-read `replyQueued`.

## Parent integration

The shared `native_ui_changed` event with `domain: 'questions'` already exists.
The parent's existing `sessionProjections.onChanged` listener can map keys with
`isUserQuestionProjectionKey(key)`; `userQuestions` is the required
invalidation, `inbox` is an optional refinement for queued replies. The adapter
does not subscribe on its own.

Recommended flow:

1. Construct one `NativeQuestionAdapter({ access })` where `NativeUiAccess` is
   the shared seam. For a live attachment supply the exact native objects:
   `{ sessionId, attachmentId, session, agent }`; for a pending attachment only
   `{ sessionId, attachmentId }`.
2. On `native_ui_changed`/`questions`, call `read()` and refresh the pending
   list/dialog. Nothing is emitted by this module; the parent coalesces reads.
3. Present a continued row through the existing `DecisionDialog` (or a list
   picker importing the exported DTO), keyed by a TUI-local id such as
   `question-continued:<callId>`, and route its submit value to
   `answer({ callId, answer: value })`.
4. On `accepted`/`queued` close the dialog locally. On `unavailable`/`stale`
   close it and re-read; never retry and never call `respond()` for that call.

## Validation scope

`test/backend-native-questions.test.ts` (26 offline tests) covers: native
projection read shape and single-cut key usage; exact Session identity; option,
question and `callId` preservation; `open` vs `continued`; multi-question,
multi-select, free-form and skip normalization; both answer input shapes;
`accepted`/`queued`/`unavailable`/`stale`; root vs delegated caller mapping;
settled/foreign/closed races (including a settlement between the UI read and
the submit, and `open` → `continued` after the first read); attachment
replacement before and during the write; pending Agent-less sessions;
missing/malformed native faces; redacted
unknown native failures; bounded warnings; no `attachWait` claim; and no
`agents`/`sessions` access (no Agent materialization). No model, profile,
credential or real session is touched.

`src/backend/native-questions.ts` was scoped-typechecked with the repository's
strict NodeNext/erasable-TypeScript settings. Only this module, its test,
this document and `.cache/native-ui-expansion/questions/` are new; shared
contracts (`types.ts`, `context.ts`, `native-ui-scope.ts`, `app.ts`) are
unchanged.

### Real native fold probe

`.cache/native-ui-expansion/questions/evidence/native-fold-probe.mjs` (a
throwaway, uncommitted dev probe) imports DSH's own installed
`foldUserQuestions` and runs it over synthetic session events, then feeds the
**real wire view** through this adapter:

- timed `tool/call` + pending result → `active: [{callId, state: 'continued',
  questions}]`; the adapter returns the same ids, option labels/descriptions,
  header and `multiSelect` unchanged;
- a synthetic `user-question-reply` user message → `active: []`,
  `settled: [{callId, answers}]`; the adapter's native batch shape matches
  exactly what DSH's fold reads out of the reply payload;
- an in-time answer batch → settled directly, never continued;
- a blocking legacy `ask_user_question` header + call + pending result →
  `{active: [], settled: []}`, proving the adapter cannot mislabel a blocking
  decision as continued.

Recorded output: `.cache/native-ui-expansion/questions/evidence/native-fold-probe.log`.
The probe reads only installed public package files; it writes nothing, starts
no model request and touches no profile.