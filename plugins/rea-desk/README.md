# rea-desk

A Claude Code mod for working with [REA](https://github.com/morluto/rea) (Reverse Engineer Anything). It wraps every REA call your agent makes, whether through the REA MCP server (`mcp__rea__*` from `rea setup`, or `mcp__plugin_rea_rea__*` from the plugin) or through the `rea` / `rea-agents` CLI in Bash.

## What it does

- **Scope guard.** `/rea-scope add <folder>` records the folders you own or are authorized to analyze, per project. Once a scope is set, any REA call whose arguments name an absolute path outside it is refused before it runs, and the agent is told to ask you instead of working around it. With no scope set, calls run and you get a one-time reminder.
- **Focus.** `/rea-focus <feature>` names the one feature under investigation. The scope and focus are added to the agent's system prompt, so it keeps to one feature at a time.
- **Evidence ledger.** `/rea-desk` opens a pane listing every REA call with its targets, outcome (ok, error, blocked) and duration. The status line shows a running summary.
- **Case files.** Every target gets a case file that persists across sessions: first and last seen, call and error counts, the REA tools used, and the focuses it was investigated under. `/rea-case` lists them and `/rea-case <path>` shows one.

- **Build-phase handoff.** `/rea-handoff` turns the focus, scope and case files into a brief for the agent and starts the forward-engineering half with [mattpocock/skills](https://github.com/mattpocock/skills): `/grill-with-docs` or `/grill-me`, then `/to-spec` and `/to-tickets`, `/tdd` or `/implement-spec`, `/code-review`, and `/improve-codebase-architecture` or `/handoff`. Install those with `claude plugin install mattpocock-skills@claude-plugins-official`, then run `/setup-matt-pocock-skills` once in the repo you build in.

## Recommended pipeline

1. Investigate with REA and its `reverse-engineer-anything` skill, inside a `/rea-scope`, one `/rea-focus` at a time.
2. Optionally turn the evidence into a plan with the REA Reconstruction Companion.
3. `/rea-handoff`, then grill the design and write the spec and tickets.
4. Build test-first and review against the spec.

The build stage uses mattpocock/skills only. Don't add obra/superpowers alongside it: both run their own plan, test and review loop, and two processes compete.

## Commands

| Command | Does |
| --- | --- |
| `/rea-desk` | Open the desk pane |
| `/rea-scope [add <dir> \| remove <dir> \| clear]` | Show or change the authorized scope |
| `/rea-focus [<feature> \| clear]` | Show or set the current focus |
| `/rea-case [<path>]` | List case files, or show one |
| `/rea-handoff [<path>]` | Brief the agent for the build phase |

## Limits

The guard checks absolute paths found in a call's arguments. It cannot see paths a tool resolves on its own (for example, relative paths or a target picked from an earlier result). It is a guardrail for an honest agent, not a security boundary. Only analyze software you own or are authorized to examine.

## Install

From this fork's marketplace:

```text
/plugin marketplace add Clvrwrk/rea
/plugin install rea-desk@rea
```

Or load the folder directly while developing: `claude --plugin-dir plugins/rea-desk`.
