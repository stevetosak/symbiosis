# Plan: comprehension first

Status: direction agreed with the operator on 2026-10-14. Not built yet.
Work it slice by slice; each slice is one branch and one pull request (see
AGENTS.md). Stop at each "Gate" and wait for the operator.

## What I understood

Fully agentic coding is fast, but the developer stops understanding the code,
and review cannot keep up with the volume. The operator wants to be at about
70–80% of agentic speed and keep real comprehension.

Watching code being typed (the replay) is passive and does not give that.
Comprehension comes from thinking about how a piece of code fits: its
contract, its place in the flow, how it integrates. So:

- **The developer draws the boundaries, the agent fills them.** The developer
  writes the seams: types, signatures, module boundaries, one line of intent
  per function, test case names. The agent writes bodies, boilerplate, test
  bodies. The throttle is on structural decisions, never on typing speed.
- **Learning is on ask only.** No profile, no ambient notes, no quizzes, no
  tutorials. When the developer does not know a concept, language feature,
  tool or service, they ask at that spot and get a short answer about *this*
  code, with drill-down.
- **The replay stays, as an option.** It is no longer the centre.

## The decisions

| # | Question | Decision |
|---|---|---|
| 1 | Core loop | Stub-fill: the developer writes a signature + intent + a stub body; the agent fills one stub |
| 2 | Throttle | A scope guard on the agent's edits, not a speed |
| 3 | Structural changes by the agent | Blocked; the agent proposes them with a `propose` tool; the developer accepts or rejects in the editor |
| 4 | Learning | Ask-based only: cursor, selection or `why!`; short answer, drill-down on any term |
| 5 | Where answers live | A drawer anchored to the line, saved locally in `.symbiosis/notes/`, never in the source by default |
| 6 | Grounding | Every answer links to docs or source; later, LSP hover |
| 7 | Agent | Stay on pi |
| 8 | Editor | Stay on stock ttt now; the logic moves out of the plugin so the editor is a thin view |
| 9 | Fork of ttt | Later, only for APIs that block a feature the operator validated by daily use (Gate 2) |
| 10 | Replay | Optional mode, default unchanged for now |

## Not in scope

- A profile of what the developer knows; automatic "this is new to you" notes.
- Quizzes, staged lessons, spaced repetition.
- Editor features inside ttt's Go code (until Gate 2).
- Other agents (ACP, Claude Code hooks). The core must make them possible
  later, nothing more.

## The parts, after this plan

```
pi extension ──► core (TS)          ◄── editor adapter (thin)
  tool_call guard   stubs, guard,         render marks, drawers,
  side calls        context, notes,       send cursor/selection,
  propose tool      protocol, channel     accept/reject
```

| Part | File | Job |
|---|---|---|
| Core | `core/` (new) | Pure where possible: protocol types, channel interface, stubs, guard checks, ask context, notes store |
| Channel | `core/channel/` | An interface; the file implementation (today's `pi/channel.ts`) behind it; a socket one later |
| Stubs | `core/stubs.ts` | tree-sitter: find stubs, the enclosing function, its signature node and its body range |
| Guard | `core/guard.ts` | Pure: given an edit and the active stub, allow or reject with a reason |
| Ask | `core/ask.ts` | Builds the side call's context; parses the answer (grows out of `pi/help.ts`) |
| Notes | `core/notes.ts` | `.symbiosis/notes/<path>.jsonl`, anchored by line + a hash of the line's text |
| pi extension | `pi/` | Wires core into pi: `tool_call`, `propose`, side calls |
| ttt plugin | `ttt/symbiosis/plugin.lua` | Draws and sends input; holds no rules |

## Slice 0: check pi's API (no code to merge)

Find out and write the answers into this file, under "Answers":

1. Can a `tool_call` handler block a call and give the model a reason (for
   example `return { block: true, reason }`)? Today `pi/index.ts` only
   returns `undefined` there.
2. Can an extension add a parameter to pi's built-in `edit` and `write`
   tools, or wrap them? If not, the rationale comes from a companion tool
   (`why`, called after an edit).
3. Is `web-tree-sitter` (WASM) usable from the extension under pi's Node
   (22.19+), with grammars for TypeScript, Kotlin, C#, Go, Python, Lua?
   Measure the load time.
4. Can an extension's tool wait for the developer (for `propose`) without
   blocking other events?

**Gate 0:** show the answers to the operator before slice 1.

## Slice 1: extract core (no change in behaviour)

- Move the protocol types, the channel, `help.ts` and `stream.ts` logic into
  `core/`. `pi/` imports from `core/`.
- The channel becomes an interface; the file implementation stays the only
  one.
- Done when: `npm test` and every e2e script in README.md "Test" pass with no
  change to their expectations.

## Slice 2: stubs and the scope guard

The differentiator. Build it before anything else.

**Stub syntax.** A function whose body is only a stub marker:
`TODO(pi)` in a comment, or the language's own (`todo!()`, `TODO()` in
Kotlin, `throw new NotImplementedException()`), with the marker comment
present. The developer's one-line intent is the doc comment above the
signature.

**Trigger.** `fill!` at the end of the marker line, or a palette command
"symbiosis: Fill This Stub" on the cursor's stub. It sends pi one user
message: the file, the stub's signature, intent and range, and the rule
"edit only inside this body".

**The guard** (`core/guard.ts`, pure), on each `edit`/`write` while a stub is
active:

- Reject an edit whose changed range is outside the stub's body.
- Reject a change to the signature node's text.
- Reject a new top-level declaration, a new file, or a new import of a package
  that is not in the project's manifest.
- Allow private helpers inside the body (closures, local functions).
- A `write` to the stub's file is checked as an edit (diff old vs new).
- The rejection text tells the model what boundary it hit and to use
  `propose` for it.

**`propose` tool.** Arguments: `kind` (`new_file`, `new_decl`, `signature`,
`dependency`, `outside_edit`), `what`, `why`. The editor shows it in a drawer:
Enter accepts, Esc rejects, both with an optional one-line note. The result
goes back to the model. An accepted proposal widens the allowed scope for
that one change only.

**Rationale.** Each body fill carries a short `why` for every non-obvious
choice (error handling, I/O, shared state, retries, caching). Where it comes
from depends on Slice 0, answer 2.

**Scope setting** (the panel): `stub` (the default above), `file` (the agent
may add private declarations in the file), `off` (today's behaviour).

Tests:

- Unit: `guard.test.ts` with real edits on fixture files in at least
  TypeScript and Kotlin: inside body (allow), signature change, outside
  range, new top-level, new import, `write` that rewrites the file.
- e2e `stubs.sh`: a fake pi fills a stub; a second call outside the stub is
  rejected; a `propose` is accepted and the change goes in.

## Slice 3: ask

**Trigger.** Cursor on a symbol, a selection, or a line ending in `why!`;
`ctrl+k` + a free chord (check the list in design.md) asks without a comment.
`why!` is removed from the line when the answer comes.

**Context** (`core/ask.ts`): the selection or the enclosing node
(tree-sitter), the stub's signature and intent when inside one, the `why` for
that hunk if pi wrote it, pi's plan, and the file's imports. Reuse the
side-call path of `helpi!` (not pi's conversation).

**Answer.** 2–4 lines, about this code, with at least one link to docs or
source. In a drawer anchored to the line.

**Drill-down.** In the drawer: select a term (or move to it and Enter) to ask
about it, with the parent answer as context. `+` asks for a deeper answer on
the same question. Esc closes.

**Notes.** Every answer goes to `.symbiosis/notes/<path>.jsonl`: line, hash
of the line's text, question, answer, links, time. A gutter mark shows a line
with notes; Enter on it opens them. When the line's hash no longer matches,
search nearby lines for it; else the note shows as "moved". Add
`.symbiosis/` to the project's `.gitignore` only if the operator says so on
first use.

Tests:

- Unit: context building (sizes, what is included), note anchoring after
  lines are added above, after the line changes.
- e2e `ask.sh`: a fake pi answers; drill-down sends the parent answer;
  the note survives a reopen of the file.

**Gate 1:** the operator uses slices 2 and 3 on a real project for 2–3
weeks. Write down: how often the guard rejects, how often a proposal is
accepted, asks per session, what the operator turned off and why.

## Slice 4: review per stub

- When a body lands: a drawer with the signature, the intent, the body and
  its `why` lines. `a` acks it.
- The gutter marks a filled body that is not acked; the "pi files" tab shows
  a count of un-acked bodies per file.
- `ctrl+k w` (the turn diff) stays.

## Slice 5: the follow-ups

- **show me:** from an answer, a minimal runnable example in a scratch file
  outside the project, run with the language's runner. Needs an `exec`
  permission broader than `herdr` (see Gate 2).
- **let me write it:** the agent blanks the lines the answer was about; the
  developer writes them.
- **spike:** "how would this work here?" in a stub makes a throwaway version
  on a git worktree, never merged.

## Gate 2: fork ttt or not

Keep a list, in this file, of every place stock ttt blocks a feature: the
need, the workaround, what it unblocks. Start from design.md:

| Need | Workaround today | Unblocks |
|---|---|---|
| IPC (socket or pipe) | Files polled every 40 ms | Latency, every feature |
| Programmatic buffer edits, reload from disk | Undo group, close and reopen the tab, clear notices | Replay, fills, answers |
| Decorations / virtual text | None | Inline `why`, notes |
| A gutter API | Bookmarks | Ack marks, note marks |
| LSP for plugins (hover, symbols) | None | Grounded answers, stubs |
| Scoped `exec` | `herdr` only | show me, spikes |
| Plugin key chords, show a sidebar tab | Free chords only; manual tab | UX |

Before any fork: open upstream issues for the top 2–3 needs with the use
case. A fork, if the operator decides on one, adds generic plugin APIs only
(no symbiosis features in Go), as a small patch stack rebased on upstream,
with tests in ttt's style, and a distinct version name in `install.sh`.

## Rules for the agent working this plan

- Follow AGENTS.md: a branch per slice (`feat/<name>`), a pull request, never
  push to `main`, stage files by name, run `npm test` and the e2e scripts
  the change touches.
- Write in the style of design.md: short sentences, measured facts marked as
  measured, the operator's decisions quoted.
- When a ttt limit stops a task, do not hack around it silently: add it to
  the Gate 2 table and tell the operator.
- Update design.md when a slice changes how a part works.

## Answers

Slice 0, 2026-10-14. pi 1.1.0, pi's Node v22.23.3. Every answer below is
measured, not read from docs only: probes ran the SDK with pi-ai's faux
provider (scripted model) and an inline extension. The probes are throw-away
and are not in the repository.

**1. Block with a reason: yes.** `tool_call` returns
`{ block: true, reason }` (type `ToolCallEventResult`; also `terminate?`).
Measured: the model gets a tool result with `isError: true` and the text of
`reason`, verbatim, nothing added. The first handler that blocks wins; later
handlers, in our own extension or others, do not run. A handler that throws
also blocks (fail-safe). To change the arguments instead, mutate
`event.input` in place.

**2. Add a parameter to `edit`/`write`: yes, by wrapping.** pi exports
`createEditToolDefinition(cwd)` and `createWriteToolDefinition(cwd)`. An
extension registers a tool with the same name, spreads the built-in
definition, adds `why: Type.Optional(Type.String())` to its parameters, and
in `execute` strips `why` and calls the built-in `execute`. Measured: the
model's schema shows `path, edits, why`; `tool_call` sees `why` in
`event.input`; the edit lands; the built-in renderer stays. So no companion
`why` tool is needed. Two limits:

- If a second extension also registers `edit`, pi reports a conflict
  (`Tool "edit" conflicts with …`). None of the installed extensions does
  today.
- `why` is optional in the schema; a model can leave it out. The guard can
  reject a body fill without it, if we want that.

**3. web-tree-sitter: yes, with the official grammar packages.** Measured
with `web-tree-sitter@0.27.1`: it loads in a real pi through `-e` (jiti),
`Parser.init()` takes 5–12 ms. Grammars:

| Language | Package (ships a `.wasm`) | ABI | Load (first) | Parse sample |
|---|---|---|---|---|
| TypeScript | `tree-sitter-typescript@0.23.2` | 14 | 5 ms | 3.7 ms |
| Kotlin | `@tree-sitter-grammars/tree-sitter-kotlin@1.1.0` | 14 | 7–8 ms | 3.5 ms |
| C# | `tree-sitter-c-sharp@0.23.5` | 15 | 320–370 ms | 1.7 ms |
| Go | `tree-sitter-go@0.25.0` | 15 | 52–59 ms | 0.6 ms |
| Python | `tree-sitter-python@0.25.0` | 15 | 1.4 ms | 0.7 ms |
| Lua | `@tree-sitter-grammars/tree-sitter-lua@0.4.1` | 15 | 1.3 ms | 0.3 ms |

All six, plus the runtime, are 11 MB on disk (C# 5.2 MB, Kotlin 3.3 MB).
Install them with `--ignore-scripts`: they also carry native bindings we do
not need. Load a grammar lazily, on the first file of that language, and keep
it: C# costs a third of a second once. Not usable: `tree-sitter-wasms`
(built with tree-sitter-cli 0.20, `getDylinkMetadata` fails on 0.27) and
`@vscode/tree-sitter-wasm` (no Kotlin, no Lua).

The node shapes differ per language, so `core/stubs.ts` needs one small
query per language. Measured: TypeScript, Go, Python, Lua and C# give the
function node with `name`, `parameters` and `body` fields. Kotlin's
`function_declaration` has only `name` as a field; the parameters
(`function_value_parameters`) and the body (`function_body`) are found by
node type.

**4. A tool that waits for the developer: yes.** `execute` is async and can
await a promise as long as needed. Measured, with a `propose` that waits
1.5 s: a sibling tool call in the same message finished during the wait,
other events fired, timers ran. `session.abort()` fires the tool's `signal`
at once (0.3 ms), so `propose` must listen to `signal` and reject. A message
the developer types in pi during the wait is queued (`steer` returns
`queued`) and the model sees it after the tool result.

**What this changes in the plan**

- Slice 2, Rationale: the `why` comes from the wrapped `edit`/`write`, not
  a companion tool.
- Slice 2, guard ordering: by default pi runs the `tool_call` handlers of
  every call in one message before any of them executes. So a second edit in
  the same message would be checked against the file before the first edit.
  Measured: with `executionMode: 'sequential'` on the wrapped `edit`,
  each call goes `tool_call` → execute → next call, and the guard sees the
  file as it is. Use that.
- Slice 2, replay: the replay in `pi/index.ts` streams an edit to the editor
  while the model is still typing it, before `tool_call`. The guard must be
  the first `tool_call` handler, and a blocked call must tell the editor to
  drop what it already showed. Measured: a blocked call fires no
  `tool_result`, so today the editor gets no `done` for it (only
  `tool_execution_end`).
