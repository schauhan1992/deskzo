-- CreateTable
CREATE TABLE "vault_pins" (
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vault_pins_pkey" PRIMARY KEY ("userId","credentialId")
);

-- CreateIndex
CREATE INDEX "vault_pins_userId_idx" ON "vault_pins"("userId");

-- AddForeignKey
ALTER TABLE "vault_pins" ADD CONSTRAINT "vault_pins_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_pins" ADD CONSTRAINT "vault_pins_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "vault_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;
