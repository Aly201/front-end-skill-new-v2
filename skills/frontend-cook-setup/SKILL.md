---
name: frontend-cook-setup
description: Installs and verifies everything /frontend-cook needs before it will run, namely the cook skill, the Inspo MCP server, the Awwwards MCP server, the guard hook, Node 18+, ffmpeg and a working headless browser. Use when the user types /frontend-cook-setup, when /frontend-cook says setup failed, or when the user asks to install or check the frontend design skill's dependencies.
disable-model-invocation: true
---

# frontend-cook setup

frontend-cook does not run without its dependencies. This skill installs what is missing and proves the rest works. Running it is the user's request to install, so install without asking again, but say exactly what was added.

`<fc>` means the real path of the `frontend-cook` skill folder: the sibling folder of this one (`../frontend-cook`). If it is not there, find it with the same search the scripts use: `.claude/skills/frontend-cook`, `~/.claude/skills/frontend-cook`. If it is nowhere, say: install with `npx skills add Aly201/front-end-skill-new-v2`, and stop.

## Steps

1. From the project root: `node <fc>/scripts/preflight.mjs --install --write`.
   It installs, only when missing:
   - **cook** skill: `npx -y skills add Leonxlnx/cook -g -y -a claude-code`
   - **Inspo** MCP (hosted, nothing to run locally): `claude mcp add -s user --transport http inspo https://inspomcp.dev/api/mcp`
   - **Awwwards** MCP: `claude mcp add -s user awwwards -- npx -y awwwards-mcp`
   - **Guard hook** in the project's `.claude/settings.json` (PreToolUse on Write/Edit/MultiEdit/NotebookEdit/Bash, on Read/Glob/Grep, and on MCP tools, and UserPromptSubmit): enforces mockup-first and static-first, protects the files only scripts write, and logs activity for the separate-judge, judge-read and active-time checks. Read, Glob and Grep are logged and never blocked. Tell the user it was added; they can see it in `/hooks`. If `.claude/settings.json` is not valid JSON, the hook is not written; the check fails and the user must fix the file.
   - **An old hook** (one that does not match Read, Glob and Grep) is detected as outdated. Running `preflight.mjs --install --write` again upgrades it in place. Hooks load at session start, so restart Claude Code after an upgrade.
   - **Browser** (Playwright + Chromium into `~/.frontend-cook`), only when no Playwright is found.
   Without the `claude` CLI it writes both MCP servers into the project's `.mcp.json` instead.
2. Only Node and ffmpeg are not installed for you. If either check fails, give the user the one command for their system and stop:
   - Node 18+: https://nodejs.org
   - ffmpeg: macOS `brew install ffmpeg`, Debian/Ubuntu `sudo apt install ffmpeg`, Windows `winget install ffmpeg`
   The browser is installed automatically by `--install` when it is missing. If its FAIL line remains after that, give the user `npm i -D playwright` then `npx playwright install chromium` in the project, and stop. (The agent-browser tool is not used.)
3. Read the output. Report every line as PASS or FAIL in plain words. Do not summarize a FAIL as "mostly fine".
4. If an MCP server or the hook was just added or upgraded, it loads only in a new session. Tell the user: restart Claude Code (or open `/mcp` and reconnect), then run `/frontend-cook`. Stop here.
5. If nothing was added: call `get_filters` (Inspo) and `list_categories` (Awwwards). Both must answer. If a tool is not in your tool list even though the config has it, say so: the server failed to start (for Awwwards, `npx -y awwwards-mcp` must work in a terminal; for Inspo, `https://inspomcp.dev` must be reachable).
6. When everything passes and both MCPs answered: "Setup verified. Run /frontend-cook."

## Done when

- [ ] `cook/PREFLIGHT.json` says `"ok": true`.
- [ ] The guard hook matches Read, Glob and Grep as well as the write tools (an old hook was upgraded by `--install`).
- [ ] One Inspo tool and one Awwwards tool answered in this session.
- [ ] The user knows exactly what was installed, and whether a restart is needed.
