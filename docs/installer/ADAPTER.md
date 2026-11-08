# Installer passport adapter

Scope: the common server/Docker installer in this Kit repository. The reusable
Living System Passport skill is installed at
`~/.codex/skills/living-system-passport/SKILL.md` (canonical upstream
[alrch/living-system-passport](https://github.com/alrch/living-system-passport)).
[AGENTS](../../AGENTS.md) invokes it for future changes. This adapter contains
project facts, not a second copy of the skill.

Canonical current descriptions:

- [Technical passport](PASSPORT.md), stable IDs INS-01–INS-03.
- [Product guide](PRODUCT_GUIDE.md), chapters linked to those IDs.
- [Project overview](PROJECT_OVERVIEW.md), scoped to this installer mini-project.
- [Evidence](evidence-2026-11-02.md), source/review/test boundaries and findings.

Local reading views are generated under `readable/` by
`node scripts/render-installer-docs.mjs`; [Project help](readable/PROJECT_OVERVIEW.html)
is the start page. The renderer accepts exactly these four descriptions plus
the evidence document. Generated `readable/` HTML and the local navigation map are ignored by Git; after checkout/transfer build the views with the command above. Each is a standalone HTML page; links open separately
with noopener noreferrer. No hosted URL/publication is established.

The primary server command is `python3 scripts/deploy.py ACTION PRIVATE_DEPLOY_JSON`; host Node is optional. The stdlib bootstrap reuses an available Node>=24 or extracts only the public binary from the accepted native Linux image into an invocation-private temporary directory. The original Node CLI remains supported.

The deploy JSON owns nonsecret instance/path/runtime intent and an immutable
already provisioned Docker image identity. Private server config owns tokens,
PIN authentication and project configuration. Docker owns runtime identity and
mount readback. The shared `runtime/deploy/compose.mjs` factory owns reviewed Compose identity/guard/checkpoint/proxy lifecycle. The owning project supplies its small trusted fixed definition and existing shared-lock launcher. The common receipt and transaction journal own installer progress.
No historical evidence overrides current source or runtime inspection.

Use exact changed files and INS IDs to select the affected entries, neighbors
and guide chapters. Read current source along the chain CLI → config validator →
installer → Docker/owning adapter → receipt/data; inspect the immediate consumers
in [service runtime](../../runtime/service.mjs), [server](../../server/app.mjs)
and [deployment guide](../DEPLOY.md). Existing widget/client/bug workflow behavior
is outside this scoped passport; this increment does not change those APIs.

Commands from the repository root:

- `python3 -m unittest discover -s tests -p 'test_installer_bootstrap.py'`: bounded tar extraction, native/image binding, capacity before write, ownership, partial/foreign cleanup, host-runtime reuse and finite private-channel output.

- `node --test tests/installer.test.mjs tests/installer-compose.test.mjs`: parser, private paths, read-only plan,
  adoption/idempotency, state binding, lock, recovery guard and finite diagnostics, plus the shared Compose foreign-resource/config/source/neighbor/missing-container/atomic/retry controls.
- `BUG_KIT_DOCKER_TEST_IMAGE=sha256:… node --test tests/installer.docker.mjs`:
  explicit opt-in, already verified local image; genuine disposable Docker driver
  lifecycle and data preservation checks. An unset image skips it visibly.
- `npm test`: existing Kit unit/API gates plus the new installer unit controls.
- `node scripts/render-installer-docs.mjs`: build allowlisted reading views and
  validate local document/source links. Rebuild when these descriptions change.
- `node --check scripts/deploy.mjs`: CLI syntax; the test suite imports its
  runtime modules. Browser/widget tests remain relevant only if those paths change.

Graph navigation: Graphify is available; no Kit-wide graph or Codebase Memory
index was previously established. The bounded AST map is `docs/installer/navigation/graph.json` (46 nodes/125 edges after the shared Compose move). Refresh with `graphify update runtime/deploy --no-cluster`, then copy its generated graph.json into that documented location after reviewing the affected delta. Query with `graphify query "deploy rehearse activate rollback" --graph docs/installer/navigation/graph.json --budget 1000`. The current CLI reports its legacy node-ID warning; this narrow map is navigation evidence, not a completeness claim. Graph edges select source reads; they are not executed
scenario evidence. The Python bootstrap/CLI entry points are outside this runtime/deploy AST map and are traced through their current source and focused controls. New unlinked files must also be inspected with source search.
Architecture/cycle, clone, unused-code and registry analyzers are not configured
for this new scope. Focused manual source/dependency review and the real CLI/
Docker negative controls apply; no debt baseline or new analyzer dependency is
introduced. Local tests/rendering are real commands; no commit hook, published
CI check or required branch check for installer semantics is claimed. The existing image-release workflow source now runs the Python bootstrap controls alongside npm tests before build; this local change is not proof of a published CI run.

Before agent-run commit/push, review the exact changed scope against this pair
and overview, including new files and immediate neighbors. Record the inspected
revision/delta and justified no-change decisions in evidence, not a passport
changelog. After merge/release, bind the pair to the actual accepted revision and
runtime; local fixture evidence does not establish a deployed owning project.
Publication and bug processing require their own authorization.
