# gpt-pro-cli

A small local CLI for asking ChatGPT Pro from scripts and agents through a real
Chrome session.

It keeps its own Chrome profile, opens or creates a dedicated ChatGPT project
named `CLI_QUESTIONS`, sends prompts there, supports zip uploads, and stores the
answer plus files on disk. It is a browser bridge, not an OpenAI API client.

## Install

```sh
npm install -g https://github.com/AmirTlinov/gpt-pro-cli/releases/download/v0.1.3/gpt-pro-cli-0.1.3.tgz
```

Or install the same release from the Git tag:

```sh
npm install -g github:AmirTlinov/gpt-pro-cli#v0.1.3
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
gpt-pro sessions
gpt-pro ask --session latest -- "Continue from the latest project session"
gpt-pro archive
gpt-pro stop
```

## Files

The browser profile is stored in `~/gpt-pro/browser-profile`, so login survives
between runs. Message artifacts are stored as:

```text
~/gpt-pro/chats/<session>/message-<n>/
```

Each message contains `prompt.md`, `answer.md`, `meta.json`, `receipt.json`,
`receipt.md`, uploaded attachments, downloaded answer links/files, and extracted
zip contents when present. Receipts include hashes, warning counts, and file
counts so agents can verify local artifacts without trusting terminal output.

`gpt-pro archive` writes portable zip snapshots for the selected ChatGPT project
to:

```text
~/gpt-pro/archives/
```

## Configuration

`GPT_PRO_PROJECT` changes the ChatGPT project name. `GPT_PRO_HOME` changes the
local storage root. The default browser mode is visible Chrome; headless mode is
available with `GPT_PRO_BROWSER_MODE=headless`, but ChatGPT may challenge it.

Downloader limits can be changed with `GPT_PRO_MAX_DOWNLOAD_BYTES` and
`GPT_PRO_DOWNLOAD_TIMEOUT_MS`.

## Notes

The CLI uses a dedicated browser profile instead of copying cookies from your
daily Chrome profile. This keeps login persistent without mixing agent traffic
into your normal browser state.
