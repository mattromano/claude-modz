# claude-modz

Mods for [Claude Code](https://claude.com/claude-code): function-hook plugins that add panes, hooks and commands to the terminal UI.

## Mods

### `dbt-runs`

A band above the prompt that records every dbt command Claude runs through Bash. It sits at the bottom in both the default and fullscreen layouts.

- **Captures** the standard dbt console output (what you'd see in your terminal, not `logs/dbt.log`) for `run`, `build`, `test`, `seed`, `snapshot`, `compile`, `show`, `ls`, `retry`, `clone`, `run-operation`. Housekeeping (`deps`, `clean`, `debug`) is ignored.
- **Live**: output is tee'd to a log file as it streams, so backgrounded and long-running jobs are tracked too. The pane tails the run while it's going.
- **History** across all sessions: start time, repo, command, status (✓ / ⚠ / ✗), duration, `PASS/WARN/ERROR/SKIP` counts, size on disk.
- **Open** any run (click in fullscreen, or `ctrl+x tab` then ↑↓ + Enter) for its summary and the last 500 lines of output.
- **Clean up**: delete a run, `Clear finished`, or `Clear >7d`.
- **Minimize** (`m`) hides the band; runs stay stored. `/dbt-runs` or the next dbt run brings it back.

Logs live in `~/.claude/claude-modz/dbt-runs/`; the run index lives in the plugin's store.

| Command | Does |
| --- | --- |
| `/dbt-runs` | Show the band |
| `/dbt-runs clear` | Delete every finished run |
| `/dbt-runs clear-week` | Delete finished runs older than 7 days |

The band also appears on its own when a dbt run starts.

**How capture works**: a dbt command is rewritten to
`{ ( <cmd> ) ; echo $? > <run>.rc ; } 2>&1 | tee <run>.log ; ( exit "$(cat <run>.rc)" )`,
so Claude sees the same output and the same exit code. One side effect: a `cd` inside a dbt command no longer persists to the next Bash call.

## Install

```
/plugin install dbt-runs --marketplace mattromano/claude-modz
```

Answer `y` to add the marketplace, then pick a scope (user is recommended).

## Develop

```bash
claude plugin validate dbt-runs
claude plugin test dbt-runs
claude --plugin-dir ./dbt-runs   # load from the working copy for one session
```
