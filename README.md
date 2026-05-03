# gpt-pro-cli

A small local CLI for asking ChatGPT Pro from scripts and agents through a real
Chrome session.

It keeps its own Chrome profile, opens or creates a dedicated ChatGPT project
named `CLI_QUESTIONS`, sends prompts there, supports zip uploads, and stores the
answer plus files on disk. It is a browser bridge, not an OpenAI API client.

## Quick Start

```sh
npm install
npm link
gpt-pro login
gpt-pro ask -- "Think through this carefully..."
```

## Commands

```sh
gpt-pro doctor
gpt-pro login
gpt-pro ask --attach ./bundle.zip -- "Question for ChatGPT"
gpt-pro sessions
gpt-pro stop
```

## Files

The browser profile is stored in `~/gpt-pro/browser-profile`, so login survives
between runs. Message artifacts are stored as:

```text
~/gpt-pro/chats/<session>/message-<n>/
```

Each message contains `prompt.md`, `answer.md`, `meta.json`, uploaded
attachments, downloaded files, and extracted zip contents when present.

## Configuration

`GPT_PRO_PROJECT` changes the ChatGPT project name. `GPT_PRO_HOME` changes the
local storage root. The default browser mode is visible Chrome; headless mode is
available with `GPT_PRO_BROWSER_MODE=headless`, but ChatGPT may challenge it.
