# Personaut: one-shot prompt

Copy the prompt below into an AI coding agent working in the target application repository.

```text
Set up and run one safe, local `@lodado/personaut` exploration in this repository.

Goal: produce one evidence-backed Personaut report against an existing loopback development server. Complete the work without follow-up questions; reuse the repository's package manager and scripts.

Rules:
- Require Node.js 20+. Install `@lodado/personaut` as a development dependency and install Chromium only when each is absent.
- Find an existing local start/dev command and use a loopback URL only (`http://127.0.0.1:<port>` or `http://localhost:<port>`). If there is no runnable loopback server, stop before browser execution and report the exact missing prerequisite.
- Create `personaut.study.yaml` only if it is absent, using `personaut init`. Update it for one public, read-only task on the local app: exact loopback `baseUrl` and `allowedOrigins`, one persona, one seed, a deterministic URL, visible-text, or element success oracle, and a safety policy that allows navigation but disallows click, typing, upload, mutation, external origins, and confirmations.
- Run `personaut validate personaut.study.yaml`, then start the local server, wait for the loopback URL, and run `personaut run personaut.study.yaml --output=.personaut/one-shot`.
- Report `.personaut/one-shot/reports/report.html`, `summary.json`, and `validity.json`; inspect validity before describing any result. Treat it as synthetic exploration only, never a conversion or real-user claim.
- Do not use staging or production URLs, credentials, storage state, auth bootstrap, Hermes, external origins, GitHub publication, mutation-capable actions, or destructive flows. Do not overwrite an existing study or report directory.

Finish with: local URL, task/oracle, exact commands run, output paths, changed files, and validation/test result. If the local server or a safe public page is unavailable, do not run the browser; report the blocker and the command needed to resume.
```
