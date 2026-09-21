-- CreateEnum
CREATE TYPE "InternalFeedbackKind" AS ENUM ('PRAISE', 'CONCERN', 'SUGGESTION', 'GRIEVANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "SurveyKind" AS ENUM ('FORM', 'POLL', 'VOTE');

-- CreateEnum
CREATE TYPE "SurveyStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "SurveyAudience" AS ENUM ('EVERYONE', 'DEPARTMENT', 'INDIVIDUAL');

-- CreateEnum
CREATE TYPE "SurveyQuestionKind" AS ENUM ('RATING', 'SCALE_1_10', 'SINGLE_CHOICE', 'MULTI_CHOICE', 'YES_NO', 'TEXT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'SURVEY_ASSIGNED';
ALTER TYPE "NotificationType" ADD VALUE 'FEEDBACK_SUBMITTED';

-- CreateTable
CREATE TABLE "internal_feedback" (
    "id" TEXT NOT NULL,
    "kind" "InternalFeedbackKind" NOT NULL DEFAULT 'OTHER',
    "aboutUserId" TEXT,
    "rating" INTEGER,
    "body" TEXT NOT NULL,
    "submittedOn" DATE NOT NULL,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewNote" TEXT,

    CONSTRAINT "internal_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_quotas" (
    "userId" TEXT NOT NULL,
    "onDate" DATE NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "feedback_quotas_pkey" PRIMARY KEY ("userId","onDate")
);

-- CreateTable
CREATE TABLE "surveys" (
    "id" TEXT NOT NULL,
    "kind" "SurveyKind" NOT NULL DEFAULT 'FORM',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "anonymous" BOOLEAN NOT NULL DEFAULT true,
    "mandatory" BOOLEAN NOT NULL DEFAULT false,
    "audience" "SurveyAudience" NOT NULL DEFAULT 'EVERYONE',
    "status" "SurveyStatus" NOT NULL DEFAULT 'DRAFT',
    "opensAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "surveys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "survey_questions" (
    "id" TEXT NOT NULL,
    "surveyId" TEXT NOT NULL,
    "kind" "SurveyQuestionKind" NOT NULL DEFAULT 'SINGLE_CHOICE',
    "prompt" TEXT NOT NULL,
    "helpText" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "survey_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "survey_targets" (
    "id" TEXT NOT NULL,
    "surveyId" TEXT NOT NULL,
    "userId" TEXT,
    "departmentId" TEXT,

    CONSTRAINT "survey_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "survey_participations" (
    "id" TEXT NOT NULL,
    "surveyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "skippedAt" TIMESTAMP(3),
    "responseId" TEXT,

    CONSTRAINT "survey_participations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "survey_responses" (
    "id" TEXT NOT NULL,
    "surveyId" TEXT NOT NULL,
    "submittedOn" DATE NOT NULL,

    CONSTRAINT "survey_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "survey_answers" (
    "id" TEXT NOT NULL,
    "responseId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "number" INTEGER,
    "text" TEXT,
    "choices" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "survey_answers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "internal_feedback_submittedOn_idx" ON "internal_feedback"("submittedOn");

-- CreateIndex
CREATE INDEX "internal_feedback_aboutUserId_idx" ON "internal_feedback"("aboutUserId");

-- CreateIndex
CREATE INDEX "surveys_status_idx" ON "surveys"("status");

-- CreateIndex
CREATE INDEX "survey_questions_surveyId_idx" ON "survey_questions"("surveyId");

-- CreateIndex
CREATE UNIQUE INDEX "survey_targets_surveyId_userId_key" ON "survey_targets"("surveyId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "survey_targets_surveyId_departmentId_key" ON "survey_targets"("surveyId", "departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "survey_participations_responseId_key" ON "survey_participations"("responseId");

-- CreateIndex
CREATE INDEX "survey_participations_userId_idx" ON "survey_participations"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "survey_participations_surveyId_userId_key" ON "survey_participations"("surveyId", "userId");

-- CreateIndex
CREATE INDEX "survey_responses_surveyId_idx" ON "survey_responses"("surveyId");

-- CreateIndex
CREATE INDEX "survey_answers_responseId_idx" ON "survey_answers"("responseId");

-- CreateIndex
CREATE INDEX "survey_answers_questionId_idx" ON "survey_answers"("questionId");

-- AddForeignKey
ALTER TABLE "internal_feedback" ADD CONSTRAINT "internal_feedback_aboutUserId_fkey" FOREIGN KEY ("aboutUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_feedback" ADD CONSTRAINT "internal_feedback_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_quotas" ADD CONSTRAINT "feedback_quotas_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_questions" ADD CONSTRAINT "survey_questions_surveyId_fkey" FOREIGN KEY ("surveyId") REFERENCES "surveys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_targets" ADD CONSTRAINT "survey_targets_surveyId_fkey" FOREIGN KEY ("surveyId") REFERENCES "surveys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_targets" ADD CONSTRAINT "survey_targets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_targets" ADD CONSTRAINT "survey_targets_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_participations" ADD CONSTRAINT "survey_participations_surveyId_fkey" FOREIGN KEY ("surveyId") REFERENCES "surveys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_participations" ADD CONSTRAINT "survey_participations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_participations" ADD CONSTRAINT "survey_participations_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "survey_responses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_surveyId_fkey" FOREIGN KEY ("surveyId") REFERENCES "surveys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_answers" ADD CONSTRAINT "survey_answers_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "survey_responses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_answers" ADD CONSTRAINT "survey_answers_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "survey_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
