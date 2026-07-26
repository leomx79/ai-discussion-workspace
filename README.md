# AI Discussion Workspace

This private workspace consolidates the source, fixtures, references, and design documents used for the Ansteel-style multi-agent discussion work.

## Layout

- `pi-agent/`: primary Pi Agent product source. The Ansteel governance implementation lives in `packages/coding-agent/`.
- `ansteel-e2e-*/`: deterministic and real-provider end-to-end fixtures used to validate governance and algorithmic work.
- `kilo-ansteel-template/`: Kilo integration template.
- `_ref_*/`: third-party multi-agent discussion and debate implementations retained for comparison and research.
- Root-level Python, PowerShell, and Markdown files: earlier discussion tooling, records, and design material.

## Repository Boundary

The repository intentionally excludes dependencies, generated build files, runtime reports, local model configuration, logs, and credentials. Each included project retains its own install and test instructions; run commands from that project directory.

The historical Git metadata for previously nested repositories is preserved outside this workspace before consolidation. This root repository tracks their working-tree source as a single private workspace.
