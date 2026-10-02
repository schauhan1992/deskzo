-- Sign-in rules (owner, 2 Oct 2026): how one person, or everybody in a role, may sign in — "Microsoft only",
-- single sign-on, password only — over the company's own setting. See src/lib/workplace/sign-in-rules.ts.

-- CreateEnum
CREATE TYPE "SignInMethod" AS ENUM ('SSO', 'MICROSOFT', 'GOOGLE', 'ZOHO', 'PASSWORD');

-- CreateTable
CREATE TABLE "sign_in_rules" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "roleKey" TEXT,
    "method" "SignInMethod" NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sign_in_rules_pkey" PRIMARY KEY ("id")
);

-- One rule a person, one a role.
CREATE UNIQUE INDEX "sign_in_rules_userId_key" ON "sign_in_rules"("userId");
CREATE UNIQUE INDEX "sign_in_rules_roleKey_key" ON "sign_in_rules"("roleKey");

-- A rule goes with the person or the role it is about.
ALTER TABLE "sign_in_rules" ADD CONSTRAINT "sign_in_rules_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sign_in_rules" ADD CONSTRAINT "sign_in_rules_roleKey_fkey" FOREIGN KEY ("roleKey") REFERENCES "roles"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- About a person or a role — exactly one of them.
ALTER TABLE "sign_in_rules" ADD CONSTRAINT "sign_in_rules_one_subject" CHECK (("userId" IS NULL) <> ("roleKey" IS NULL));
