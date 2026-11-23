# Any platform (Codex, Cursor, Antigravity and others)

Frontend Cook was built in Claude Code, where a guard hook logs every prompt, read and write. Other agents have no such hook. Three commands do the same job without one, and they also keep a weaker model on track. They work the same in Claude Code.

## 1. The user types their own words: `gate.mjs say` and `gate.mjs approve`

Approvals, overrides, calibrations and "no motion" need the user's own words. Without a hook, the agent could claim the user said something they never said. So the user types the words in **their own terminal**:

```bash
node <skill>/scripts/gate.mjs say
```

It asks for a line and records it in `cook/.ledger.jsonl` as `UserTTY`. After that, the agent may quote those words: `gate.mjs approve mockup --quote "<words the user typed>"`. Or the user runs the approval directly, which asks and records in one go:

```bash
node <skill>/scripts/gate.mjs approve mockup
```

Both refuse to run without an interactive terminal (an agent's tool cannot answer them). The agent must stop and ask the user to run the command. It must never type the words itself.

## 2. A judge that is a script: `judge.mjs`

The separate judge of step 8 (and any other round) can be a script instead of a second session:

```bash
node <skill>/scripts/judge.mjs --round r03
```

It sends **only** the round's side-by-sides, A/B pairs (redesign) and fold stills, and the rubric, to the Claude API. No code, no brief, no conversation, no earlier scores. The model answers in a fixed JSON schema. The script writes `cook/judge/<round>/judge-<letter>.json` itself, with the model, the API message id and the sha1 of every image it sent.

- Options: `--model` (default `claude-opus-5-5`), `--effort` (default `high`), `--max-images` (default 20).
- Needs: the `@anthropic-ai/sdk` package (`preflight.mjs --install` puts it in `~/.frontend-cook`) and Claude API credentials. The **user** sets `ANTHROPIC_API_KEY` in their own environment (or runs `ant auth login`). Never paste a key into chat or a tracked file.
- Run it 2 or 3 times for 2 or 3 judges; each run takes the next free letter.
- The gate accepts its file as fresh and separate, with or without a ledger, only when every recorded image is still on disk with the same sha1 and is from this round. A changed still, a forged hash, or a file written with an agent's Write tool is rejected by `gate.mjs score` and step 8.
- A refusal, a cut-off answer or invalid JSON writes nothing: run it again.

## 3. What to do next: `gate.mjs next`

```bash
node <skill>/scripts/gate.mjs next
```

Prints the next step, the section of `references/workflow.md` to read first, and up to 10 things still missing, in order. When a missing item needs the user, it says so. A weak or forgetful agent runs this after every action instead of guessing: do the first missing item, run `next` again, never claim a step is done until `gate.mjs verify <step>` exits 0.

## Several agents, one project

Every agent on every computer works from the same state, because `cook/` is committed with the project:

- **`cook/STATUS.md`** is written by the gate after every change: the current step, the bar, the user's decisions (their exact words), the references (source, URL, what to take), the judged rounds and what is still missing. Every agent reads it first.
- **The `AGENTS.md` block** (written by `gate.mjs init` and `gate.mjs share`, also into `CLAUDE.md` when the project has one) tells Codex, Cursor, Antigravity and Claude Code to read `cook/STATUS.md`, run `gate.mjs next`, use only the listed references, and never approve for the user. Only the text between the `frontend-cook` markers is touched.
- **`cook/FILES.json`** keeps the real time each file last changed, with its content hash. A clone stamps every file with the checkout time, which would break every "stills newer than the code" check and every approval. With this record, a file whose content is unchanged keeps its real time on every computer; a file that really changed uses its new time.
- **Stays on each computer** (git-ignored by `preflight.mjs --install`): the prompt log `cook/.ledger.jsonl`, `cook/PREFLIGHT.json` and `cook/.checkout`. Run setup on each computer. The user's words typed on one computer are recorded in `cook/GATES.json` once they are used in an approval, so they travel with it.

The routine:

1. `git pull`, then read `cook/STATUS.md`.
2. One agent builds at a time. Others may judge (`judge.mjs`) or read.
3. After every step or round: `node <skill>/scripts/gate.mjs share`, then commit `cook/` together with the build and push.
4. A merge conflict in `cook/GATES.json`, `cook/FILES.json` or `cook/STATUS.md` means two agents built at once: stop and ask the user which side to keep, then run `gate.mjs share` again.

**Keep the repository private.** `cook/refs/` holds screenshots of other people's sites; committing them to a public repository publishes them. Preflight warns when the GitHub repository is public.

## What still needs Claude Code

These checks read the guard hook's log, so outside Claude Code they cannot pass on their own:

- **Step 1: Inspo and Awwwards calls logged.** Without a hook there is no log of MCP calls. If the platform has those MCP servers, use them and list every reference in `cook/refs/SOURCES.md`; the user may then record an override with their own words (`gate.mjs say`, then `gate.mjs override 1 --quote "..." --reason "..."`). It stays in the final report.
- **The time floor (step 4, checked at step 8)** counts active time from the log. Without a log, set a cap with the user's words or record an override.
- **Blocking**: only the hook blocks design code before the mockup passes and motion before the static design passes. Without it, the gate still refuses to verify the step, so work done early is wasted and redone, not skipped.

## A short brief for another agent

> Use Frontend Cook. Run `git pull` and read `cook/STATUS.md` first. Before every step run `node <skill>/scripts/gate.mjs next` and do the first missing item; read the step's section in `references/workflow.md`. Never say a step is done until `gate.mjs verify <step>` exits 0. You cannot approve anything: when the user's words are needed, stop and ask them to run `node <skill>/scripts/gate.mjs say` (or `gate.mjs approve <kind>`) in their own terminal. Judges are `node <skill>/scripts/judge.mjs --round <round>`, run at least twice per round. After each step or round run `gate.mjs share`, then commit `cook/` with the build and push. Never edit files under `cook/judge/`, `cook/GATES.json`, `cook/FILES.json`, `cook/STATUS.md` or `cook/reports/` by hand.
