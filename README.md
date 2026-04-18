# Ai-Assistant

Agent-orchestration pipeline for automating short-form content creation and publishing across Instagram, YouTube, and TikTok.

## What it does

Coordinates multiple AI agents to ideate, produce, and schedule short-form social content end-to-end:

- **Ideation** — topic selection and script drafting
- **Production** — audio, visual, and caption assembly
- **Publishing** — scheduling and posting via each platform's API

## Repository layout

- `AGENTS.md`, `CLAUDE.md` — agent instructions and task context
- `.claude/`, `.beads/` — agent tooling configuration (Claude Code + Beads task tracker)
- `docs/` — design notes and decisions
- `workspace-mirror/` — per-agent isolated workspaces

## Status

Active development. Experimental — orchestration harness and content-pipeline scaffolding are in place; publishing integrations to Instagram / YouTube / TikTok are in progress. Not production-ready.
