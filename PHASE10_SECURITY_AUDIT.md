# Phase 10 — Final Security Audit

**Branch:** master
**Baseline commit:** `71bc4c7cca` (Phase 9 — structured logging)
**Date:** 2026-08-04
**Scope:** Verification only — no production code changes unless a critical issue was found.

---

## 1. Database

| Check | Status | Evidence |
|---|---|---|
| RLS enabled on tenant tables | ✅ PASS | `tenant_isolation` policies confirmed on 10 tables (ai_detections, audit_logs, camera_view_logs, cameras, events, incidents, notification_rules, recordings, sites, snapshots) |
| Worker least privilege | ✅ PASS | `media_node_worker` role (migration 029): SELECT/INSERT/UPDATE only on camera_setup_tasks, cameras, media_nodes, sites, camera_stream_tokens — **no DELETE on cameras**, no access to users/organizations/payment tables |
| No privilege escalation | ✅ PASS | Workers operate under restricted role via `MEDIA_NODE_DATABASE_URL`; owner-role fallback emits a startup warning (`worker.owner_role_fallback`) |
| SSL validation | 🟡 WARNING | API pool (`db/index.js`) and Better Auth (`lib/auth.js`) use `ssl: { rejectUnauthorized: false }`. Connection is TLS-encrypted but the certificate chain is **not** verified. Neon requires TLS, so encryption is guaranteed; strict validation remains a hardening recommendation for Phase 13 (verify Neon CA bundle first, then enable). Workers inherit `sslmode` from the Neon connection string. |

## 2. Authentication

| Check | Status | Evidence |
|---|---|---|
| User roles | ✅ PASS | `users.user_type` CHECK constraint: platform_admin / org_admin / operator / customer_viewer |
| Admin permissions | ✅ PASS | `requireAuth` + org-scoped checks; `canAccessCamera(auth, camera_id)` used before issuing stream tokens |
| Organization isolation | ✅ PASS | All API queries run through `queryAsOrg(auth.organizationId, ...)`; `SET LOCAL app.current_org_id` + RLS policies enforce tenant isolation |
| Stream token validation | ✅ PASS | `lib/handlers/verify-stream-token.js` — **fail-closed**: unknown/expired token → 403; token must match camera + `expires_at > now()` |

## 3. Streaming security

| Check | Status | Evidence |
|---|---|---|
| Invalid token rejected | ✅ PASS | verify-stream-token returns 403 for unknown tokens |
| Expired token rejected | ✅ PASS | `expires_at > now()` enforced in verification query |
| Deleted cameras cannot stream | ✅ PASS | `camera_stream_tokens.camera_id` FK → cameras ON DELETE CASCADE removes tokens automatically |
| Tenant isolation preserved | ✅ PASS | Token issued only after `canAccessCamera`; verification checks org ownership |
| Token lifetime | ✅ PASS | `crypto.randomBytes(32)` (256-bit), expires in 1 hour |
| Rate limiting | ✅ PASS | `lib/_rate_limit.js` token-bucket applied on camera-views; configurable via `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` |

## 4. Credentials

| Check | Status | Evidence |
|---|---|---|
| Encrypted storage only | ✅ PASS | Camera passwords stored as `rtsp_password_encrypted` (AES-256-GCM, migration 030 + `lib/_crypto.js`); task credentials encrypted too |
| No plaintext leaks | ✅ PASS | `rtsp_url` scrubbed of `user:pass@`; plaintext wiped after task completion |
| No secrets in logs | ✅ PASS | Phase 9 `lib/_logger.js` redacts tokens/passwords; structured logs include timestamp, component, severity, event, task_id, camera_id |
| Safe cleanup | ✅ PASS | Phase 7 cancel/sweep removes temporary credentials; `cleanup` task mode |

## 5. Code hygiene

| Check | Status | Evidence |
|---|---|---|
| No hardcoded secrets in repo | ✅ PASS | Secret-scan on api/lib/workers found no tokens/credentials; `.gitignore` excludes `.env*` |
| Auth on public endpoints | ✅ PASS | Health endpoint public (no data); all data endpoints require auth |
| Parameterized SQL | ✅ PASS | All queries use `$1..$n` parameters; `SET LOCAL` org id validated against UUID regex before interpolation |
| Input validation | ✅ PASS | Zod schemas on camera-views, cameras, setup tasks, etc. |

---

## Verdict

**✅ PASS — no critical issues found. 1 warning (non-blocking):**

> 🟡 **SSL certificate validation is disabled** (`rejectUnauthorized: false`) in API/Better-Auth pools. TLS encryption is active (Neon requires it), so data in transit is encrypted. **Recommended before go-live (Phase 13):** verify Neon's CA chain with strict TLS enabled in a staging environment, then switch to `rejectUnauthorized: true`.

**Non-blocking follow-ups (already scheduled in later phases):**
- Strict SSL validation enablement (Phase 13 deployment verification)
- Backup & disaster recovery plan (Phase 11)
- Performance testing (Phase 12)

No code changes were required during this audit.
