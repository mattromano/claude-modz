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

Each dbt call in a Bash command is routed through a shell function that copies dbt's own output to `~/.claude/claude-modz/dbt-runs/<run>.log` as it streams:

```
__dbt_runs_tee() { { DBT_USE_COLORS=true "$@"; echo $? > <step> ; } 2>&1 | tee -a <run>.log | perl -pe '<strip colors>' ; ... }
{ ( <cmd, with each `dbt <subcmd>` prefixed by __dbt_runs_tee> ) ; echo $? > <run>.rc ; } ; ( exit "$(cat <run>.rc)" )
```

The tee sits on the dbt call itself, so the log is complete even when the command redirects dbt (`> build.log 2>&1`) or filters it (`| tail -3`, `| grep Done`); only dbt's output is logged, not the rest of the command's. The log keeps dbt's colors for the band. Claude sees the same output without the color codes, and the same exit code.

The run's status comes from dbt's own exit code (`<run>.dbt.rc`, the last failing call wins), not from whatever ran last in the command. `dbt <subcmd>` text inside a heredoc or a quoted string is not a call and is left alone. Not caught: dbt started from inside another script (a `dbt.sh` wrapper) or a `bash -c "..."` string. One side effect: a `cd` inside a dbt command doesn't carry over to the next Bash call.

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
