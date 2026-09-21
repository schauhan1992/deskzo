# Wroffy ERP

Internal ERP for Wroffy (system integrator — Microsoft 365 / Adobe / Autodesk subscriptions and hardware), built as independently toggleable modules from the start. Currently ships CRM (LinkedIn sourcing → qualification → lead pipeline & proposals → customer conversion) and Items & Inventory (goods/services/subscriptions catalog with stock tracking). See [docs/ROADMAP.md](docs/ROADMAP.md) for what's built, what's next, and the module-registry convention new modules should follow.

## Stack

Next.js 15 (App Router) · Prisma · PostgreSQL · Auth.js (Credentials) · Tailwind CSS · Zod · React Hook Form.

## Setup

```bash
cp .env.example .env
# generate a real secret for AUTH_SECRET:
npx auth secret

npm install
npm run docker:up        # starts Postgres in Docker
npm run db:migrate        # applies the schema
npm run db:seed           # creates admin@wroffy.com / ChangeMe123!
npm run dev
```

Open http://localhost:3000, sign in with the seeded admin account, and change the password.

## Data model

`User` (roles: Admin, Profile, Calling, Sales, Support, Management) · `Company` (globally unique by name) · `Contact` · `Lead` · `Activity` · `Proposal`. See [prisma/schema.prisma](prisma/schema.prisma).

## Scripts

- `npm run dev` / `build` / `start` — Next.js app
- `npm run db:generate` / `db:migrate` / `db:studio` / `db:seed` — Prisma
- `npm run docker:up` / `docker:down` — local Postgres
