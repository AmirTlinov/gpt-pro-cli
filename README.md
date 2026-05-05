# gpt-pro-cli

A small local CLI for asking ChatGPT Pro from scripts and agents through a real
Chrome session.

It keeps its own Chrome profile, opens or creates a dedicated ChatGPT project
named `CLI_QUESTIONS`, sends prompts there, supports zip uploads, and stores the
answer plus files on disk. It is a browser bridge, not an OpenAI API client.

## Install

```sh
npm install -g https://github.com/AmirTlinov/gpt-pro-cli/releases/download/v0.1.14/gpt-pro-cli-0.1.14.tgz
```

Or install the same release from the Git tag:

```sh
npm install -g github:AmirTlinov/gpt-pro-cli#v0.1.14
```

For local development:

```sh
npm install
npm link
```

## First Run

```sh
gpt-pro doctor
gpt-pro login
gpt-pro smoke
gpt-pro ask -- "Think through this carefully..."
```

## Commands

```sh
gpt-pro doctor
gpt-pro login
gpt-pro ask --attach ./bundle.zip -- "Question for ChatGPT"
gpt-pro ask --github-repo AmirTlinov/gpt-pro-cli -- "Use GitHub connector context and review this design"
gpt-pro sessions
gpt-pro ask --session latest -- "Continue from the latest project session"
gpt-pro archive
gpt-pro archive --delete-local
gpt-pro stop
```

Agents can also use the bundled sidecar helper for quiet parallel thinking:

```sh
printf '%s\n' "Question for GPT PRO" | gpt-pro-sidecar start --label side-thinking
printf '%s\n' "Repo-grounded question" | gpt-pro-sidecar start --label review --github-repo AmirTlinov/gpt-pro-cli
gpt-pro-sidecar wait <run-dir>
printf '%s\n' "Final pressure" | gpt-pro-sidecar flagship <run-dir>
```

`gpt-pro-sidecar start` returns a run directory immediately and detaches a real
worker process, so the browser action survives after the calling agent's shell
turn exits. `wait` blocks until completion and prints status, stdout, stderr, the
answer body, and a compact receipt summary, so agents do not need to poll and
then manually `cat` files. `status` is fail-closed: a dead worker without
`exit_code` is reported as `FAILED`, not as a forever-pending run, and completed
runs include answer/receipt/url fields inline. Receipt warnings make sidecar
runs exit non-zero, so agents do not accidentally treat missing downloads,
unproven project grounding, or connector failures as clean success. `flagship`
asks the same ChatGPT thread for a final strengthening pass, so agent workflows
can use GPT PRO without turning the chat into manual copy/paste.

## GitHub Grounding

For repo-specific questions, pass `--github-repo owner/repo`. The CLI tries to
select that repository through ChatGPT's GitHub connector, sends a prompt that
explicitly requires using the connector, and records the requested/selected
repositories in `meta.json` and `receipt.json`.

```sh
gpt-pro ask --github-repo AmirTlinov/gpt-pro-cli -- "Find the risky parts of the current CLI design"
```

The repository should already be visible/indexed in ChatGPT's GitHub connector.
If ChatGPT's connector UI cannot be selected reliably, the CLI still sends the
connector-required prompt but records a warning in `receipt.json`. Treat that as
"prompt-enforced, UI selection unconfirmed", not as silent success.

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

`gpt-pro archive` writes portable zip snapshots for the selected ChatGPT project
to:

```text
~/gpt-pro/archives/
```

`gpt-pro archive --delete-local` first writes the zip, then deletes only the
local chat directories that were actually included in that archive. It does not
delete ChatGPT web chats or any local chat outside the selected project archive.

## Configuration

`GPT_PRO_PROJECT` changes the ChatGPT project name. `GPT_PRO_HOME` changes the
local storage root.

The default browser mode is `background`: a normal Chrome session using the
persistent `~/gpt-pro/browser-profile`, launched with a deterministic window
size for agent work. It is intentionally not true headless by default because
ChatGPT currently tends to challenge headless sessions.
`gpt-pro login` always opens visible Chrome so you can complete auth or a human
challenge. Fully headless mode is still available with
`GPT_PRO_BROWSER_MODE=headless`, but ChatGPT often challenges headless browser
sessions; use it only when you have verified it on the current machine.

Downloader limits can be changed with `GPT_PRO_MAX_DOWNLOAD_BYTES` and
`GPT_PRO_DOWNLOAD_TIMEOUT_MS`.

## Notes

The CLI uses a dedicated browser profile instead of copying cookies from your
daily Chrome profile. This keeps login persistent without mixing agent traffic
into your normal browser state.
