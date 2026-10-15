# Bug Report Kit API and helper

The authenticated endpoints use `Authorization: Bearer <team token>`. `BUG_KIT_URL` is the server's HTTPS base URL; local testing may use `http://127.0.0.1:7337`. The token's configured project list and role control access.

With a checkout of this repository, use `node scripts/bug-kit-agent.mjs` from its root. It reads `BUG_KIT_URL` and `BUG_KIT_TOKEN` from the environment and prints JSON:

```text
node scripts/bug-kit-agent.mjs me
node scripts/bug-kit-agent.mjs projects
node scripts/bug-kit-agent.mjs list new
node scripts/bug-kit-agent.mjs show BUG_ID
node scripts/bug-kit-agent.mjs screenshot BUG_ID /tmp/bug-screenshot.png
node scripts/bug-kit-agent.mjs action BUG_ID /tmp/bug-action.json
node scripts/bug-kit-agent.mjs summary 2026-10-01 2026-10-31 group
```

The screenshot command creates a new file and refuses to overwrite an existing one. The action file is JSON and must contain the `revision` from the latest `show` plus an `action`. Example:

```json
{"revision": 3, "action": "ask", "note": "На какой странице это повторяется?"}
```

For `resolve`:

```json
{
  "revision": 4,
  "action": "resolve",
  "rootCause": "Обработчик не проверял пустой ответ API",
  "resolution": "Добавлена обработка пустого ответа и сообщение пользователю",
  "fixEvidence": {
    "repositories": [{"name": "example-web", "ref": "commit-or-PR"}],
    "checks": [{"name": "npm test -- form", "result": "passed"}],
    "contours": ["dev"]
  }
}
```

Endpoints, if the helper is unavailable:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/me` | Actor name and role |
| GET | `/api/projects` | Visible projects and repository hints |
| GET | `/api/reports?status=new&offset=0` | Tickets, 100 per page |
| GET | `/api/reports/ID` | Full ticket JSON and latest revision |
| GET | `/api/reports/ID/screenshot` | Image bytes |
| GET | `/api/reports/ID/related` | Similar tickets |
| GET | `/api/reports/ID/html` | Human-readable ticket |
| PATCH | `/api/reports/ID` | JSON `{revision, action, ...}` |
| GET | `/api/summary?from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=group` | Period statistics |
| GET | `/api/summary/html?from=YYYY-MM-DD&to=YYYY-MM-DD` | Period HTML |

Developer actions are `claim`, `start`, `ask`, and `resolve`. Reviewer actions are `triage`, `answer`, `accept`, `reject`, `cancel`, `reopen`, and `group`. `note` is required for questions, answers, acceptance, rejections, cancellation, reopening, and grouping. `accept` requires `ready_for_check`; a developer token cannot perform it. Every mutation requires the latest integer `revision`; a stale revision returns HTTP 409. The full status contract is in this repository's `docs/WORKFLOW.md` when the checkout is available.
