-- Which kinds of device one person may use, over their role's rule (owner, 18 Oct 2026). Null is "as the role".
CREATE TABLE "user_access_policies" (
    "userId" TEXT NOT NULL,
    "allowMobile" BOOLEAN,
    "allowTablet" BOOLEAN,
    "allowComputer" BOOLEAN,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "user_access_policies_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "user_access_policies" ADD CONSTRAINT "user_access_policies_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_access_policies" ADD CONSTRAINT "user_access_policies_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
