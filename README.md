# claude-modz

Mods for [Claude Code](https://claude.com/claude-code): plugins that add panes, bands and commands to the terminal UI.

## Mods

| Mod | What it does |
| --- | --- |
| [`dbt-runs`](dbt-runs/README.md) | Watch every dbt command Claude runs, live, from a band above the prompt, with history, dbt's colors and cleanup |
| [`dbx-trace`](dbx-trace/README.md) | Flight recorder for Databricks: every query, script and guardrail block, in a band above the prompt and a per-session HTML trace with deep links |

## Install

```
/plugin install dbt-runs --marketplace mattromano/claude-modz
/plugin install dbx-trace --marketplace mattromano/claude-modz
```

Answer `y` to add the marketplace, then pick a scope (user is recommended).

## Develop

Each mod is a folder with its own `.claude-plugin/plugin.json`, listed in `.claude-plugin/marketplace.json`.

```bash
claude plugin validate <mod>
claude plugin test <mod>
claude --plugin-dir ./<mod>   # load a working copy for one session
```
