-- CreateTable
CREATE TABLE "tenant_job_leases" (
    "tenantId" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "leasedUntil" TIMESTAMP(3) NOT NULL,
    "holder" TEXT NOT NULL,
    "lastStartedAt" TIMESTAMP(3),
    "lastFinishedAt" TIMESTAMP(3),
    "lastOk" BOOLEAN,
    "lastError" TEXT,

    CONSTRAINT "tenant_job_leases_pkey" PRIMARY KEY ("tenantId","job")
);

