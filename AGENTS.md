# Loop project instructions

Read `docs/PLAN.md` and `docs/PROGRESS.md` before starting work. Update them when decisions or verified progress change. Distinguish user decisions from implementation defaults. Never claim unverified external playback or device compatibility.

## Product boundaries

- A small hobby project: Vue, PixiJS, a single Node service, SQLite and direct SQL. No ORM, audio proxy/transcoding, microservices or speculative abstractions.
- No text chat, custom stickers or uploads. Only server-allowlisted emotes.
- Netease metadata/URL resolution runs server-side; browsers fetch public audio directly. Bilibili is deferred and must be abandoned if direct playback needs a proxy.
- Old projects describe historical behavior; do not inherit their architecture or IMusicApi.
- Keep third-party credentials server-only; never commit `.env`, database files or private cookies.

## Collaboration and validation

- Primary owns requirements, architecture, shared interfaces, coordination and final acceptance. Complete bounded tasks directly.
- Delegate substantial read-only discovery to `explorer`; implementation and meaningful tests to `worker`, with `fork_turns="none"` and concise briefs. At most two open subagent threads; subagents must not delegate further.
- Assign disjoint file ownership. Do not repeat completed exploration or unchanged passing checks without an integration reason.
- Run `npm run check`, `npm test` and `npm run build` for the initial implementation. Add behavior tests for room transitions, identity isolation and persistence. Report browser/device verification limits.
- For work requested by the Loop maintainer, verify completed changes, commit the files for that task, and push to the configured upstream on `origin` (`git@github.com:biuuu/loop.git`). If the first push is still pending, use `git push -u origin main` for the initial `main` branch. Use a regular push and report failures. Deployment is a separate task.
- If the workspace has a read-only `.git` placeholder and a local `.loop-git/` metadata directory, use `git --git-dir=.loop-git --work-tree=.` from the project root.
- For routine visual changes, do not automatically run browser tests or capture screenshots. The user reviews the appearance; use type checks and focused behavior tests as needed. Run browser QA only when explicitly requested.
