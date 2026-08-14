# eLeague. — Matchday Manager

A focused operations dashboard for running an eFootball league without losing track of fixtures, results, teams, or confirmation status. The interface is designed around the league database: every fixture has a clear lifecycle, every result is reviewable, and standings update only after a result becomes official.

## Product overview

**eLeague.** gives league administrators one calm workspace for matchday operations. The dashboard combines the official table, fixture desk, activity feed, database health indicators, team directory, and a guided result-entry flow so managers can move from an upcoming fixture to a verified league record with minimal friction.

The current experience includes the following workflows:

| Workflow | What it supports |
| --- | --- |
| Overview | Live matchday status, pending-result attention card, season progress, activity feed, and next fixtures |
| Fixtures & results | Seven-round round-robin schedule, status filters, team search, result review, and confirmation actions |
| Result entry | Large score fields, scorer/minute logging, incomplete-goal guidance, and clear save/cancel actions |
| Standings | Points, goal difference, goals scored, form, and deterministic sorting |
| Teams & managers | Roster directory with manager identity and current competition statistics |
| Database | Typed league entities, seeded demo records, local persistence, and recovery to a valid seed state |

## Database model

The database layer lives in [`client/src/lib/league-db.ts`](client/src/lib/league-db.ts). It defines typed entities for leagues, teams, matches, goals, activities, and calculated standings. The data model is intentionally explicit so the UI can treat database state as the single source of truth.

A match moves through the following lifecycle:

> `SCHEDULED` → `PENDING` → `CONFIRMED`

Scheduled matches have no result. A manager can submit a score and optional scorer details, which creates a pending result. The table and player leaderboard only include confirmed matches, keeping official statistics protected from unreviewed submissions.

The layer also provides a deterministic round-robin fixture generator, standings calculation, goal leaderboard aggregation, pending/confirmed counters, and formatted match labels. In the browser, the current database snapshot is stored under `eleague-manager-database-v1` in `localStorage`, allowing the demo workflow to survive refreshes without requiring a backend service.

## Technology

The project is a Vite-powered React and TypeScript application with Tailwind CSS utilities, Lucide icons, and a local typed data layer. The visual system uses a dark navy operations shell, high-contrast data surfaces, restrained status colors, and responsive layouts for desktop and smaller screens.

## Getting started

Install dependencies with pnpm:

```bash
pnpm install
```

Start the development server:

```bash
pnpm dev
```

The Vite server runs on port `3000` by default. The application is available at `http://localhost:3000`.

Run the type check:

```bash
pnpm check
```

Create a production build:

```bash
pnpm build
```

Preview the client build locally:

```bash
pnpm preview
```

## Vercel deployment

The application is a static Vite build. Vercel should use the following settings:

| Setting | Value |
| --- | --- |
| Framework preset | Vite |
| Install command | `pnpm install` |
| Build command | `pnpm build` |
| Output directory | `dist/public` |
| Node.js version | 22 or newer |

The repository includes the client build output configuration in [`vite.config.ts`](vite.config.ts). No database credentials or server-side secrets are required for the current local-first demo database.

## Validation

The completed experience has been checked with the TypeScript compiler and production bundler. Browser verification covered the overview dashboard, fixture filters, result-entry drawer, score validation guidance, pending-result submission, confirmation state changes, team directory, add-team form, and empty-form validation.

## Repository structure

```text
client/
  src/
    lib/league-db.ts     Typed database, scheduling, and standings logic
    pages/Home.tsx       Main eLeague dashboard and interaction flows
    index.css            Responsive product styling
  index.html             Application metadata and branding
server/
  index.ts               Existing production server entrypoint
vite.config.ts           Vite root and build configuration
package.json             Scripts and dependencies
```

## Notes for future production work

The current implementation is intentionally local-first and is ideal for validating the league workflow and user experience. A production version should replace the `localStorage` adapter with a shared server database, add authenticated manager roles, persist audit events, and introduce conflict handling for simultaneous submissions. The typed entities and match lifecycle are designed to make that migration straightforward.

## License

This project is released under the MIT license declared in [`package.json`](package.json).


## Production backend and database

The application now includes an Express API under `server/` and a Vercel serverless entrypoint at `api/index.ts`. The database is MySQL 8+ or TiDB compatible and is initialized from [`database/schema.sql`](database/schema.sql). All business timestamps are stored as UTC epoch milliseconds.

The `users.email` column is the primary key for identity. Each user has an `admin` or `player` role, and player accounts may belong to one team through `team_memberships`. Administrators can create teams and player accounts, generate a season schedule, review submitted results, and confirm official results. Players can sign in with their email, view their assigned fixtures, and submit results only for fixtures involving their team. Sessions are revocable database records stored behind an HttpOnly cookie.

### Backend setup

Copy `.env.example` to `.env` and provide a MySQL or TiDB `DATABASE_URL`. Then run:

```bash
pnpm db:migrate
BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
BOOTSTRAP_ADMIN_NAME="League Administrator" \
BOOTSTRAP_ADMIN_PASSWORD="use-a-strong-password" \
pnpm db:bootstrap
```

Set `VITE_BACKEND_ENABLED=true` for the frontend build. In Vercel, configure `DATABASE_URL`, `DATABASE_SSL=true`, `DB_POOL_SIZE`, and `VITE_BACKEND_ENABLED=true` as project environment variables. The API exposes `/api/health`, `/api/auth/login`, `/api/auth/me`, `/api/auth/logout`, `/api/dashboard`, admin team/user/season operations, result submission and confirmation endpoints, standings, and player statistics.

### Compatible scheduling and standings

The schedule generator uses a round-robin circle method. It creates each pairing once, prevents a team from appearing twice on the same matchday, and supports an odd number of teams by inserting a bye. Official standings are calculated only from confirmed matches using points, goal difference, goals scored, wins, direct head-to-head points, and a stable team-name fallback. Schedule and tie-breaker behavior is covered by the backend test suite.

Run the checks with:

```bash
pnpm vitest run --config vitest.config.ts
pnpm check
pnpm build
```
