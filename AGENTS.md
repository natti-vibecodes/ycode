# Agent rules — Codex / non-Claude agents working in this repo

You are one of several AI agents working on Natalia's Scalability website. A Claude planning
session orchestrates the project. These rules keep parallel work safe. They are NON-NEGOTIABLE.

1. **Read CLAUDE.md first** — it is the working agreement (design-system law, measurement doctrine,
   verbatim-copy rules, never-destroy list). Everything there binds you exactly as it binds Claude.
2. **Branches + worktrees only.** Never commit directly to main. Work on a feature branch in your
   own git worktree; the planning session reviews and merges. One task = one branch.
3. **NEVER touch the Supabase database directly and never call the MCP/builder APIs.** All Ycode (CMS/builder) edits go through the Claude
   planning session — it owns the MCP connection, the publish-gate discipline, and the one-writer
   rule. Your lane is repo files only.
4. **NEVER run servers on ports 3002/3003** — the Ycode dev server and review mirror live there.
5. **NEVER press or trigger Publish** in anything. Publishing is Natalia's move alone.
6. **The /nyc page is frozen.** No edits of any kind, by anyone.
7. **Her design exports are verbatim sources** — copy ships exactly as written; deviations are
   questions for her, never edits.
8. **Leave a trail.** Every finished task: clear commit messages on your branch + append a short
   entry to linear-pending.md (what/why/files) so the ticket board stays truthful.
9. **Cross-review protocol:** when asked to review Claude's work, review the named commit range on
   main and write findings to a file (review-<date>.md on your branch) — file:line evidence,
   no style nitpicks, verify claims by running the code/tests, never "fix" things outside your task.
