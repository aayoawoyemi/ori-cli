# bench / 2026-04 — run summary

Date: 2026-04-27
Model: claude-sonnet-4-6

## Matrix

| task | aries-cli | claude-code | pi-coding-agent |
|---|---|---|---|
| 01-cache-break-trace | ✓ 29894/2/70s | ✓ 61962/3/27s | — |
| 02-repl-failure-audit | ✗ 10733/1/300s | ✗ 254220/10/174s | — |
| 03-mode-reminder-inventory | ✓ 11278/2/101s | ✓ 21561/1/27s | — |
| 04-postflight-gate | ✓ 30065/2/35s | ✓ 56420/2/22s | — |
| 05-vault-warmth-trace | ✗ 0/0/300s | ✗ 112678/8/45s | — |
| 06-pi-system-prompt | ✓ 20851/3/70s | ✓ 35037/1/18s | — |
| 07-pi-parallel-tool | ✗ 0/0/300s | ✓ 21331/3/70s | — |
| 08-pi-provider-compare | ✗ 10478/2/43s | ✓ 14176/0/22s | — |
| 09-pi-tool-count | ✗ 50846/4/28s | ✓ 34798/8/97s | — |
| 10-pi-agent-loop | ✗ 61559/5/148s | ✓ 34662/3/91s | — |

Legend: success / total tokens / tool calls / wall seconds

## Per-CLI aggregates

| cli | success rate | mean tokens | mean tool calls | mean wall |
|---|---|---|---|---|
| aries-cli | 4/10 | 22570 | 2.1 | 139.5s |
| claude-code | 8/10 | 64685 | 3.9 | 59.2s |
