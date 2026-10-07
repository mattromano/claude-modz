# dbt-runs

Watch every dbt command Claude runs, from a band above the prompt.

- **Live**: each `run`, `build`, `test`, `seed`, `snapshot`, `compile`, `show`, `ls`, `retry`, `clone` or `run-operation` shows up as it starts, and its output streams in. Background runs are tracked too.
- **History** across sessions: time, repo, command, status (✓ ⚠ ✗), duration, PASS/WARN/ERROR/SKIP counts, size on disk.
- **Open a run** to see its full output in dbt's own colors. It opens at the end; scroll with the mouse wheel or trackpad.
- **Clean up**: delete a run, `Clear finished`, or `Clear >7d`.

## Use

| | |
| --- | --- |
| `/dbt-runs` | Show the band |
| `/dbt-runs clear` | Delete every finished run |
| `/dbt-runs clear-week` | Delete finished runs older than 7 days |
| Click a row | Open that run (or `ctrl+x tab`, then ↑↓ and Enter) |
| `b` / `d` | Back to the list / delete the open run |
| `m` | Minimize; runs stay saved, and `/dbt-runs` or the next run brings it back |
| `ctrl+x ctrl+a` | Expand the band again if Claude Code's `[-]` collapsed it |

The band also appears by itself whenever a dbt run starts.

## How it works

A dbt command is wrapped so its output is copied to `~/.claude/claude-modz/dbt-runs/<run>.log` as it streams:

```
{ ( export DBT_USE_COLORS=true; <cmd> ) ; echo $? > <run>.rc ; } 2>&1 | tee <run>.log | perl -pe '<strip colors>' ; ( exit "$(cat <run>.rc)" )
```

The log keeps dbt's colors for the band. Claude sees the same output without the color codes, and the same exit code. One side effect: a `cd` inside a dbt command doesn't carry over to the next Bash call.

## Try it without a warehouse

`../tools/fake-dbt/dbt` prints realistic dbt output:

```bash
FAKE_DBT_SCENARIO=error FAKE_DBT_DELAY=1 ../tools/fake-dbt/dbt build -s model_a model_b
```

`FAKE_DBT_SCENARIO` is `success`, `warn` or `error`; `FAKE_DBT_DELAY` is seconds per model.

## Develop

```bash
claude plugin validate .
claude plugin test .
```
