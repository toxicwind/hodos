# Changelog

Auto-backfilled from git history 2026-11-02 (real commits only).

## 2026-11-02
- build(proxy): release-fast profile (thin LTO + 8 units) + cc 1.11.0 (ec11fcd)
- fix(proxy): tier-tolerant lane routing + streaming path through the router chain (f5e5b08)

## 2026-11-01
- router strategies: repoint state writes/reads from ghost estate/.state to var/state (lease fix) (f085877)

## 2026-10-31
- chore: remove orphan bin/__pycache__ (source py long gone, zero refs) (861dc7d)
- docs: real top-level README (router role, layout, live facts); archive stale .bak shells into docs/history (627eeb4)

## 2026-10-28
- fix(proxy): relay verified gateway headers on all lanes (85f5373)
- fix(proxy): source keyring secrets via --show --json env (quote-safe) (3ff70aa)
- feat(proxy): forward verified freeinference gateway headers through the proxy hop (4af7771)
- test(ua): contract canary — every outbound fetch carries explicit EstateRouter UA (anomaly #14, CF 1010) (99aa4dd)
- fix(router): 12-hour quarantine for 404/410 vanished models and 429 limiter shed-not-strike rule (66891ab)

## 2026-10-27
- feat(gate): /api/gate ops visibility - per-provider in-flight/limit rows (freeinference queue observable) (955c64f)
- feat(proxy): pgate — per-provider concurrency gate (max_parallel on ProviderDef, 0=ungoverned); freeinference  (798616e)
- test: fix RouterInner test initializer for the model_strikes decay-class field (23/23 router tests green) (5dcdd08)
- fix(geode): per-model strike DECAY CLASSES — 402/404/410 vanished-model class decays 12h (the minimax-flash th (7a5df79)
- chore(proxy): sync generated provider catalog (freeinference model id updates) (ae984f5)
- fix(proxy): export keyring vars so they survive exec (set -a) (a35f312)
- feat(router): per-model credit/auth strikes — a 402 must not cost a failover hop every request (5515ef3)
- fix(proxy): forward User-Agent upstream (Cloudflare 1010 -> 403 -> router 502) (747e839)

## 2026-10-26
- feat(store): refresh catalog wire truth on every store load (no catalog<->runtime drift) (2f62fa8)
- feat(router): context-aware model pick for the auto/free lanes (2M handoff, step 2) (6fd5e12)
- feat(router): context-budget HARD GATE — 2M-context handoff premise fix (9c6e446)
- docs(coverage): refresh committed HTML snapshot to 81.91% lines (81.15% executable) (0f5406c)
- test(lib): cover env_or defaults, is_presentation_path routes/assets, unix_now (356 green) (19ebfea)
- test(proxy): cover unauthorized/overloaded/bad_gateway/deadline response builders (353 green) (d94527e)
- docs: 2M-context handoff experiment finding (routing must gate by context budget) (543ce34)
- test(router): retryable-429 failover to healthy candidate (353 green) (60f0c43)
- docs(coverage): commit llvm-cov HTML report (81.56% lines) as durable artifact (fc68d09)
- test(router): +empty-completion substance-guard integration (352 green) (880b188)
- test(router): +1 mock-upstream end-to-end integration (execute_buffered round-trip) (15ca20c)
- tests(bodybuilder): +2 pure-helper tests (normalize_max_requests clamps/defaults, result_text_from_body conten (f43f8dc)
- fix(deploy): serve.sh points at the release binary; correct stale ranch/ path + dup comment (80c3e82)
- tests(proxy): +12 tests to 348-green, coverage 78.23% -> 78.71% lines (b961ab2)
- feat(router): declared-route gate + sticky-pin failover + coverage-boosting tests (2d7f027)
- resect: first-class config (package.json scripts) + geode session stragglers (19e0fbd)
- geode cutover: redirect homes (30ff8e6)
- geode maximal rename pass 2: rename file paths (git mv) (1079626)
- geode maximal rename: cuttinggate->chalcopyrite, herd->bornite, hodos->rhodochrosite, pinax->mimetite (b12ab05)
- geode: rhodochrosite purge old-name refs (contents+env) (6546b82)

## 2026-10-25
- refactor(rhodochrosite): finish the hodos rebrand and repair the catalog sync (6b79ea5)
- refactor(rhodochrosite): rebrand hodos -> rhodochrosite (geode pen gateway) (2677b03)
