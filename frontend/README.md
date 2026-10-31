# OtabuPro ERP — web app

Next.js (App Router, Cache Components) + TypeScript + Tailwind + shadcn/ui. All data comes from the Django API through a client typed from `openapi.yaml` (`pnpm api:types`). Authorization is enforced by the API; the UI only hides what the caller can't use.

- `src/app/(auth)`: sign-in, MFA, first-login setup
- `src/app/(app)`: signed-in area (shell, approvals, account, administration)
- `src/components/shell`: navigation, ⌘K palette, step-up MFA, live notifications
- `src/components/erp`: page header, tables, status badges, form fields
- `src/lib`: API client, session and permissions, navigation, formatting
- `e2e/`: Playwright specs (see the repository README for how to run them)

Design tokens live in `src/app/globals.css`: graphite and concrete neutrals, marking yellow for "where you are" and the primary action, and ISO 3864 safety colours for statuses.
