-- CreateTable
CREATE TABLE "page_layouts" (
    "userId" TEXT NOT NULL,
    "pageKey" TEXT NOT NULL,
    "widgets" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "page_layouts_pkey" PRIMARY KEY ("userId","pageKey")
);

-- AddForeignKey
ALTER TABLE "page_layouts" ADD CONSTRAINT "page_layouts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
