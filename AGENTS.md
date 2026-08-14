# Agent coordination

- Treat a subagent's `running` status as authoritative. Reading, investigation, dependency resolution, builds, and tests may produce no visible edits or messages for several minutes.
- Give a running DeepSeek worker at least 20 minutes of cumulative grace, or at least 30 minutes for retrieval-heavy work and builds/full test suites. Wait in calls of at most 60 seconds to remain responsive; repeated wait timeouts do not indicate failure.
- Do not interrupt or replace the worker during that grace period. Afterward, send one status request and wait at least 10 additional minutes. Interrupt only with affirmative evidence of a hang, an explicit blocker/failure, a user request to stop, or a concrete safety/conflicting-write risk. Never infer a stall only from reading time, silence, or an unchanged worktree.
- When restarting delegated work at the user's request, discard the interrupted attempt's uncommitted implementation and launch a fresh subagent from the clean baseline.
