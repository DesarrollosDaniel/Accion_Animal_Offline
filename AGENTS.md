# Repository Guidelines

## Project Structure & Module Organization

This React, TypeScript, and Vite application uses Supabase. Frontend code lives in `src/`: `App.tsx` contains main views, `components/` holds UI, `lib/` holds helpers, and `styles.css` defines the visual system. Static assets live in `public/`. The local file server is in `server/`, scripts in `scripts/`, and migrations, Edge Functions, and database checks in `supabase/`. Read `README.md` for product behavior and `ALMACENAMIENTO_LOCAL.md` before changing file storage.

## Build, Test, and Development Commands

- `npm ci` installs the pinned dependencies from `package-lock.json`.
- `npm run dev` starts Vite for frontend development; local file features require the server.
- `npm run typecheck` checks TypeScript without emitting files.
- `npm run build` typechecks and creates the production bundle in `dist/`.
- `npm run local` builds and serves the application with local file access, using `.env.local` and `.env.server` when present.

There is no `npm test` script. Start a local database with `npx --yes supabase@2.117.0 start`; run SQL checks with `psql` against the local database on port `54322`.

## Coding Style & Naming Conventions

Follow the existing two-space indentation, single quotes, and no-semicolon style in TypeScript. Use `PascalCase` for React components and types, `camelCase` for functions and variables, and descriptive CSS class names. Add shared colors as custom properties near the top of `src/styles.css`; preserve the established green palette and accessible focus states. TypeScript strict mode is enabled. No formatter or linter is configured, so match nearby code and run `npm run typecheck` before submitting.

## Testing Guidelines

Database checks live in `supabase/tests/database/`. For example, run `psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -f supabase/tests/database/initial_schema.test.sql`. That file uses pgTAP; `duplicate_guardian.test.sql` is a transactional SQL check. Add checks for behavior and access policies when changing schema or RLS. There is no frontend test framework or coverage target; verify affected UI flows manually and run `npm run build`.

## Commit & Pull Request Guidelines

Recent commits use short Spanish descriptions; no enforced convention exists. Write an imperative subject, such as `Corregir búsqueda de mascotas`. In pull requests, explain the change, list verification steps, link a related issue when available, and include screenshots for visible UI changes.

## Security & Configuration

Copy `.env.example` to `.env.local` for local setup. Never commit secrets, real clinical data, or `uploaded/` contents. Keep privileged Supabase keys out of browser code. Put database changes in versioned migrations and preserve RLS and role checks for exposed data.
