# OtabuPro ERP — mobile (Expo)

Field app for storekeepers, drivers, approvers and employees: stock lookup by barcode, goods receipt against purchase orders, blind stock counts, incoming transfers, proof of delivery (signed-note photo + location), approvals, and expense claims with receipt photos.

## How it works
- **Same API and permissions as the web app.** Signs in with `client_type: mobile`; the session token is kept in the OS keychain (`expo-secure-store`). Tiles appear by permission and module flag; the server decides every action.
- **Offline-tolerant outbox** (`src/lib/queue/`). Every write is saved on the phone first (SQLite) as a job of HTTP steps, each with its own `Idempotency-Key` fixed when queued. Jobs send strictly in order when a connection is available; a lost response is replayed with the same key, so the server never acts twice. Server refusals stop the job and show the server's reason; *Try again* resends only the refused step under a new key. Photos are copied into app storage until sent.
- Every endpoint the outbox writes to must honour `Idempotency-Key`: `backend/apps/core/tests/test_mobile_idempotency.py` enforces it (keep it in step with `src/lib/operations.ts`).

## Develop
```bash
npm install
npm run api:types            # regenerate src/api/schema.d.ts from ../frontend/openapi.yaml
EXPO_PUBLIC_API_URL=https://erp.example.internal npx expo start
npm test && npm run typecheck && npm run lint
```
Native modules (camera, SQLite, secure store, location) need a development build (`npx expo run:ios|android` or EAS), not Expo Go.

## End-to-end tests (browser build, development only)
`e2e/run.sh` recreates the `otabu_erp_mobile` database (bootstrap + `seed_demo` + `e2e/setup_backend.py`, all DEMO data), starts the API on :8170, serves the web export through a same-origin proxy on :8190 and runs Playwright at phone size. The browser build stores the token in `sessionStorage` and the outbox in `localStorage`; it exists for testing — the native app is the product.
