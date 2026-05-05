# gpt-pro-cli

A small local CLI for asking ChatGPT Pro from scripts and agents through a real
Chrome session.

It keeps its own Chrome profile, opens or creates a dedicated ChatGPT project
named `CLI_QUESTIONS`, sends prompts there, supports zip uploads, and stores the
answer plus files on disk. It is a browser bridge, not an OpenAI API client.

## Install

```sh
npm install -g https://github.com/AmirTlinov/gpt-pro-cli/releases/download/v0.1.29/gpt-pro-cli-0.1.29.tgz
```

Or install the same release from the Git tag:

```sh
npm install -g github:AmirTlinov/gpt-pro-cli#v0.1.29
```

For local development:

```sh
npm install
npm link
```

## First Run

```sh
gpt-pro doctor
gpt-pro status
gpt-pro login
gpt-pro smoke
gpt-pro ask -- "Think through this carefully..."
```

## Commands

```sh
gpt-pro doctor
gpt-pro login
gpt-pro ask --attach ./bundle.zip -- "Question for ChatGPT"
gpt-pro ask --github-repo auto -- "Use GitHub connector context and review this checkout"
gpt-pro sessions
gpt-pro ask --session latest -- "Continue from the latest project session"
gpt-pro archive
gpt-pro archive --delete-local
gpt-pro stop
```

Agents can also use the bundled sidecar helper for quiet parallel thinking:

```sh
printf '%s\n' "Question for GPT PRO" | gpt-pro-sidecar start --label side-thinking
printf '%s\n' "Repo-grounded question" | gpt-pro-sidecar start --label review --github-repo auto
gpt-pro-sidecar wait <run-dir>
printf '%s\n' "Final pressure" | gpt-pro-sidecar flagship <run-dir>
```

`gpt-pro ask` prints final machine-readable fields to stdout and live progress
to stderr. The progress lines are intentionally compact, for example current
phase, elapsed time, whether ChatGPT is still generating, and the latest visible
thinking/reasoning summary when ChatGPT exposes one. Use `GPT_PRO_PROGRESS=0`
to silence those progress lines.

`gpt-pro status` does not start a browser. When a keeper is already running it
prints the current task phase, queue depth, page URL, generation state, visible
thinking preview, and answer preview. This is the command agents should call
when they need to know whether GPT PRO is still working.

`gpt-pro-sidecar start` returns a run directory immediately and detaches a real
worker process, so the browser action survives after the calling agent's shell
turn exits. `wait` blocks until completion and prints compact status fields by
default; use `wait --show` or `show` when you need stdout/stderr plus the full
answer body. `status` is fail-closed: a dead worker without
`exit_code` is reported as `FAILED`, not as a forever-pending run, and completed
runs include answer/receipt/url fields inline. While a run is still active,
`status` also surfaces the latest `gpt-pro ask` progress line from stderr, so a
calling agent can see the current phase without opening the browser. Receipt warnings make sidecar
runs exit non-zero, so agents do not accidentally treat missing downloads,
unproven project grounding, or connector failures as clean success. `flagship`
asks the same ChatGPT thread for a final strengthening pass, so agent workflows
can use GPT PRO without turning the chat into manual copy/paste.

## GitHub Grounding

For repo-specific questions from a Git checkout, pass `--github-repo auto`. The
CLI resolves the matching GitHub repository from `origin`; if there is no
`origin`, it uses the single unambiguous GitHub remote. Missing, non-GitHub, or
ambiguous remotes fail before the browser is touched, so agents do not silently
review the wrong repo.

```sh
gpt-pro ask --github-repo auto -- "Find the risky parts of this repository"
```

You can still pass `--github-repo owner/repo` explicitly, or set
`GPT_PRO_GITHUB_REPO=auto` for a repo-scoped agent shell. The sidecar preserves
the resolved repo for `flagship`, so a background review can continue in the same
thread without re-deriving the repo manually.

The repository should already be visible/indexed to ChatGPT's GitHub connector.
For each requested repo the CLI opens the GitHub repo picker, searches the exact
`owner/repo` when needed, and records whether the repo was already checked or
temporarily checked by this run. Temporary checks are cleaned up after the
answer; repos that were checked before the run are left checked.

A clean receipt requires deterministic repo-picker confirmation. A GitHub
tool-only pill or unmeasurable picker state is not accepted as clean repo
grounding. The CLI retries the picker flow and cleans any GitHub tool state it
created itself; if it still cannot prove the requested repo is checked, it fails
before submitting the prompt instead of asking GPT with ungrounded repo context.

## Files

The browser profile is stored in `~/gpt-pro/browser-profile`, so login survives
between runs. Message artifacts are stored as:

```text
~/gpt-pro/chats/<session>/message-<n>/
```

Each message contains `prompt.md`, `answer.md`, `meta.json`, `receipt.json`,
`receipt.md`, uploaded attachments, downloaded answer links/files, and extracted
zip contents when present. Receipts include hashes, warning counts, file counts,
and extraction/download warnings so agents can verify local artifacts without
trusting terminal output. Message directories are allocated atomically and the
keeper serializes browser mutations, so concurrent agent asks do not mix prompts
or overwrite `message-<n>` artifacts.

Failed asks also write a local failure receipt and print its path under
`failure:`. That means an agent can inspect the exact prompt, requested project,
GitHub repo request, and warning state even when ChatGPT login, connector
selection, attachment staging, or answer stabilization fails.

If ChatGPT shows a temporary protection screen such as “Too many requests” /
“Слишком много запросов”, or a human-verification challenge, the CLI fails fast
instead of retrying in a loop or submitting another prompt. The failure receipt
keeps the prompt and request metadata; wait for ChatGPT to lift the limit or run
`gpt-pro login` for manual recovery, then retry once.

`gpt-pro archive` writes portable zip snapshots for the selected ChatGPT project
to:

```text
~/gpt-pro/archives/
```

`gpt-pro archive --delete-local` first writes the zip, then deletes only the
local chat directories that were actually included in that archive. It does not
delete ChatGPT web chats or any local chat outside the selected project archive.
If live session refresh fails, cache-only sessions may still be archived, but
they are not deleted locally unless their saved message metadata proves project
membership.

## Configuration

`GPT_PRO_PROJECT` changes the ChatGPT project name. `GPT_PRO_HOME` changes the
local storage root.

The default browser mode is `background`: agent asks use the persistent
`~/gpt-pro/browser-profile` through Chrome's CDP path in a minimized/off-screen
Chrome window. This is intentionally not true headless by default: current
ChatGPT sessions can keep true headless Chrome on a long "One moment" protection
screen even when the same profile is logged in. The default optimizes for a
reliable agent run that does not steal the desktop.

On macOS background mode starts Chrome through LaunchServices with
`--no-startup-window` by default, then opens the ChatGPT page only after CDP is
connected and parks the window off-screen/minimized. `gpt-pro status` reports
that parking state as `background-window: ...`, so agents can see whether the
best-effort background contract was actually confirmed. Set
`GPT_PRO_MACOS_NO_STARTUP_WINDOW=0` only if your Chrome build rejects that launch
flag. Set `GPT_PRO_STRICT_BACKGROUND=1` when a run must fail before prompt
submission unless the background window was confirmed parked.

`gpt-pro doctor` prints both the CLI version and keeper version. If a keeper from
an older install is still alive, the next `ask`/`smoke` automatically restarts it
instead of reusing a stale browser worker.

`gpt-pro login` intentionally opens visible Chrome so you can complete auth or a
human challenge. True headless mode remains available explicitly with
`GPT_PRO_BROWSER_MODE=headless`; if ChatGPT keeps it on a protection/loading
screen, the CLI fails closed instead of silently falling back to a visible
browser. Fully visible agent traffic is available with
`GPT_PRO_BROWSER_MODE=headed`.

Downloader limits can be changed with `GPT_PRO_MAX_DOWNLOAD_BYTES` and
`GPT_PRO_DOWNLOAD_TIMEOUT_MS`.

## Notes

The CLI uses a dedicated browser profile instead of copying cookies from your
daily Chrome profile. This keeps login persistent without mixing agent traffic
into your normal browser state.
