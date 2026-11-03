# Plan: symbiosis for any agent, Claude Code first

Status: draft, 2026-11-03. Questions 1 to 8 answered by the operator. Slices 0
to 2 are done; the spike's results changed decision 6 and slices 3 to 5.

## What I understood

symbiosis is an editor workflow that supports the agent you use. Today it
works only with pi. It must not depend on one agent. Claude Code is the
first other agent. ttt and the channel stay as they are. Each agent gets a
thin adapter that turns its own events into the channel's events.

## The decisions

| # | Question | Decision |
|---|---|---|
| 1 | Scope of v1 | Observe (the file it writes, follow preview, plan, change list, `ctrl+k w`, changed lines), then control (stop, close, "waits for you"). helpi!, ask and fill come later. |
| 2 | Names in ttt | The session record names its agent. The UI shows `claude ✎ writing store.ts`. `helpi!` and `why!` stay for every agent. |
| 3 | Launcher | `--agent pi\|claude`, config `agent`, default pi. `agentArgs` replaces `piArgs` (piArgs is still read). |
| 4 | Install | A Claude Code plugin from this repo (`.claude-plugin/`). |
| 5 | The long-running process | A detached **keeper** per Claude session. symbiosis starts and ends it. No MCP server. |
| 6 | Plan timeline | Claude's task tools, TaskCreate and TaskUpdate (TodoWrite is gone). completed=done, in_progress=now, pending=next. They are off by default: the launcher sets `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`. |
| 7 | `why` | None for Claude in v1. |
| 8 | Code layout | `claude/` next to `pi/`. The agent-neutral half of `pi/index.ts` goes to `core/agent/`. |

## Slice 0: what the spike found

Claude Code 2.1.312, Haiku, a hook logger loaded with `--plugin-dir`, in a
herdr pane. 73 hook records.

| Question | Answer |
|---|---|
| Session id and pid | Every hook gets `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PID` in its environment, and `session_id` in its input. The hook is a direct child of Claude. |
| Session facts | SessionStart input: `source` (startup, clear), `model`, `session_title` (`-n`). `CLAUDE_CODE_SESSION_NAME` is not set. UserPromptSubmit carries `session_title` too. |
| A detached child | Lives on after the hook (ppid 1), sees `CLAUDE_PID`, sees Claude's end within 1 s. |
| `/clear` | SessionEnd (old id, `reason: clear`), then SessionStart (new id, `source: clear`). The new hooks get the new id; `CLAUDE_PID` stays. The old child runs on until its Claude ends. |
| Edit | `tool_input {file_path, old_string, new_string, replace_all}`. `tool_response {filePath, oldString, newString, originalFile, structuredPatch, userModified, replaceAll}`. |
| Write | `tool_input {file_path, content}`. `tool_response {type: create\|update, filePath, content, structuredPatch, originalFile}` (null for a new file). |
| MultiEdit, TodoWrite | Do not exist. NotebookEdit exists (not a text file: not followed). |
| Task tools | Only with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`. `TaskCreate {subject, description}` returns `{task: {id, subject}}`. `TaskUpdate {taskId, status}` returns `{statusChange: {from, to}}`. |
| A failed call | PostToolUseFailure, with `error`. |
| Permission | PreToolUse comes first, then PermissionRequest, then Notification `permission_prompt` ("Claude needs your permission"). |
| A rejected permission (No or Esc) | **No hook.** The transcript gets a rejected `tool_result`. |
| Esc during a turn | Stops it ("Interrupted"). **No hook**: no PostToolUse, no Stop. The transcript gets `[Request interrupted by user for tool use]`. |
| Stop from outside | `herdr agent send-keys <pane> esc` works. `kill -INT` does not stop the turn: it quits Claude. |
| Close from outside | `kill -TERM CLAUDE_PID`: SessionEnd runs (`reason: other`), Claude quits, the pane's shell stays. |
| Other events | A finished background task comes as UserPromptSubmit (its prompt is a `<task-notification>`). SubagentStop also comes for Claude's prompt-suggestion helper: ignore it. |

Two results change the design. Claude reports neither an interrupt nor a
rejected permission to any hook. So the keeper also reads the transcript.
And the task tools are off by default.

## How it works

```
claude ──hook──▶ claude/hook.ts ──socket──▶ claude/keeper.ts ──▶ channel files ──▶ ttt
                (one per event)            (one per session)    (as for pi)
claude ──transcript .jsonl──────────────────▲ (interrupts, rejections)
```

- `claude/hook.ts` reads the hook JSON, sends it to the keeper, prints the
  reply. With no ttt plugin folder it exits at once. With no keeper it starts
  one and sends once more. It never blocks Claude: a failure is silent.
- `claude/keeper.ts` holds the state, as the pi extension does: the session
  record, the open calls, the change log, the diff texts, the task list. It
  writes the heartbeat each second (ttt drops a record older than 4 s). It
  reads the new lines of `transcript_path` each second. It ends on
  SessionEnd, or when `CLAUDE_PID` is gone.
- The socket path is short (macOS allows 104 bytes), in a folder with mode 0700.

| Source | Keeper | Channel |
|---|---|---|
| SessionStart | Record: `agent: claude`, `pid: CLAUDE_PID`, pane, cwd, `model`, `title` | session record |
| UserPromptSubmit | working, a new run for `ctrl+k w`; `waiting` = null | `rotate` |
| PreToolUse Edit, Write | Keep the text before. Map the input to pi's shape (`path`, `content`, `edits[].oldText/newText`) | `start`, `text` (all of it), `ready` |
| PostToolUse Edit, Write | Change log, diff texts, first changed line; `waiting` = null | `done` |
| PostToolUseFailure | Drop the call | `abort` |
| PostToolUse TaskCreate, TaskUpdate | The task list, by id, as plan steps | session record |
| Notification `permission_prompt` | `waiting` = its message | session record |
| Stop, StopFailure | idle; abort the open calls | `stop` |
| Transcript: a rejected `tool_result` | Drop that call; `waiting` = null | `abort` |
| Transcript: `[Request interrupted by user` | idle; abort the open calls | `stop` |
| SessionEnd | Remove the record; the keeper ends | |

## What Claude does less well than pi

- The preview starts when the call is complete, not while the model writes.
  Then it types at your speed, as now. In default mode the preview can start
  before you allow the edit; a rejection undoes it.
- No `why`. No `files` for a plan step, so no "planned" or "unplanned" tags.
- No timeline for a Claude started without `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`.
- No stop outside herdr and tmux: Esc must go to the pane.
- No helpi!, ask, fill or review in v1. The record lists what the agent can
  do (`can`), and ttt says "claude cannot do this yet" in place of a 3 s timeout.

## Slices

Each slice ends with its check. The next slice starts only after it passes.

0. **Spike.** Done (above).
1. **Split the pi adapter.** Done. `core/agent/` gets the record, the events, the
   change log (`pi/changelog.ts`) and the diff texts (`pi/changes.ts`).
   `pi/index.ts` uses it. No change in behaviour.
   Check: `npm test`, `npm run test:lua`, the e2e scripts and demo scenarios pass unchanged.
2. **The record names its agent** (PROTOCOL 18): `agent` and `can`. Done. ttt shows
   the agent's name in place of the fixed "pi"; the status bar shows its mark
   (π pi, ✻ claude, `○ no agent`; decided 2026-11-03), and a text with no session says "the agent".
   Check: Lua tests; a pi session looks as before.
3. **Claude: observe.** `claude/hook.ts`, `claude/keeper.ts`, `claude/map.ts`
   (pure: Claude's input to pi's shape, tasks to steps), `claude/transcript.ts`
   (pure: interrupts and rejections in new transcript lines), the plugin manifest.
   Check: unit tests for `map.ts` and `transcript.ts`, with the shapes above;
   an e2e test that plays hook JSON into a keeper and a headless ttt (status
   bar, plan drawer, `ctrl+k w`); by hand: `claude --plugin-dir .` in herdr.
4. **Claude: control.** `ctrl+k q`: Esc to the pane (herdr `agent send-keys`,
   tmux `send-keys`). `symbiosis close` and `ctrl+k z`: SIGTERM to `CLAUDE_PID`,
   then the pane closes. "Waits for you" from `permission_prompt`.
   Check: e2e for close in herdr; stop by hand.
5. **Launcher.** `--agent`, config `agent` and `agentArgs`, tab
   `claude · <folder>`, `-c` gives `claude --continue`, `record.pi` becomes
   `record.agent`, and `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` for claude.
   Check: launcher tests, the layout e2e.
6. **Install.** `.claude-plugin/marketplace.json`; the plugin's root is the repo
   root, so `core/` comes along; install.sh installs it when `claude` is on PATH.
   Check: a fresh install in a clean `HOME`.

## Later, not in this plan

- helpi! and ask: a side call by `claude -p --output-format stream-json`.
  First check that it uses the subscription login.
- Fill and the guard: PreToolUse denies with the guard's reason. A proposal is
  answered in the PreToolUse hook (it waits for ttt), so no `propose` tool.
- The fill message and the helpi! `ask` kind into Claude: an `asyncRewake`
  hook, or `herdr agent prompt`.
- `why` from the transcript: the assistant text just before the tool call.

## Open questions, for their slice

- Slice 6: where the one copy lives when pi is not installed (today it is
  pi's package folder), and how the plugin gets `node_modules`.

## Is this what you want

You want symbiosis to be an editor workflow that any agent can use, not a pi
add-on. I read that as: keep ttt and the channel, and make the agent side a
thin adapter for each agent. The first new adapter is Claude Code. It uses
hooks, the session's transcript, and a keeper process that symbiosis starts
and ends itself. Claude cannot stream its tool calls, so its preview starts
later than pi's. v1 covers observe and control only. Slice 1 splits the pi
code first, so the Claude adapter uses the same rules and pi does not change.
