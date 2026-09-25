"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import type { SurveyAudience, SurveyKind, SurveyQuestionKind, SurveyStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { hasEffectivePermission } from "@/actions/permission";
import { toPlain } from "@/lib/serialize";
import {
  isAcceptingResponses,
  isTargeted,
  needsSplash,
  submissionDate,
  summarise,
  type QuestionResult,
} from "@/lib/engagement/anonymity";
import type { ActionResult } from "@/actions/company";

/**
 * Forms, polls and votes.
 *
 * ## The one rule
 *
 * On an anonymous survey, `SurveyParticipation.responseId` is never written. It is the only path
 * from a person to their answers, and `submitResponse` writes it exclusively inside a branch
 * guarded by `survey.anonymous === false`. `check:engagement` asserts the column is null for every
 * participation in an anonymous survey, because a rule enforced only by the code that happens to
 * be written today is not enforced.
 *
 * Everything else about participation — that somebody answered, that they skipped the splash — is
 * recorded openly and is what makes chasing non-responders possible without reading anybody's
 * answers.
 */

async function manager(userId: string) {
  return hasEffectivePermission(userId, "engagement.manage");
}

async function me(userId: string) {
  const row = await db.user.findUnique({ where: { id: userId }, select: { departmentId: true } });
  return { id: userId, departmentId: row?.departmentId ?? null };
}

/** The forms waiting on this person, newest first. */
export async function myOpenSurveys() {
  const user = await requireUser();
  const viewer = await me(user.id);
  const now = new Date();

  const surveys = await db.survey.findMany({
    where: { status: "OPEN" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, kind: true, title: true, description: true, anonymous: true, mandatory: true,
      audience: true, status: true, opensAt: true, expiresAt: true,
      targets: { select: { userId: true, departmentId: true } },
      participations: { where: { userId: user.id }, select: { respondedAt: true, skippedAt: true } },
      _count: { select: { questions: true } },
    },
  });

  return toPlain(
    surveys
      .filter((s) => isAcceptingResponses(s, now) && isTargeted(s, viewer))
      .map((s) => ({
        id: s.id, kind: s.kind, title: s.title, description: s.description,
        anonymous: s.anonymous, mandatory: s.mandatory, expiresAt: s.expiresAt,
        questions: s._count.questions,
        answered: s.participations[0]?.respondedAt != null,
      })),
  );
}

/**
 * The one mandatory survey to put in front of them, if any.
 *
 * `skippedInSession` comes from the caller, which holds it in a cookie rather than the database:
 * a stored skip is a permanent one unless somebody writes code to clear it, and the point of this
 * splash is that it comes back.
 */
export async function pendingSplash(skippedInSession: string[]) {
  const user = await requireUser();
  const viewer = await me(user.id);
  const now = new Date();

  const surveys = await db.survey.findMany({
    where: { status: "OPEN", mandatory: true },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, title: true, description: true, anonymous: true, mandatory: true, status: true,
      audience: true, opensAt: true, expiresAt: true,
      targets: { select: { userId: true, departmentId: true } },
      participations: { where: { userId: user.id }, select: { respondedAt: true } },
    },
  });

  const due = surveys.find(
    (s) =>
      isTargeted(s, viewer) &&
      needsSplash(s, s.participations[0] ?? null, skippedInSession.includes(s.id), now),
  );
  return due ? toPlain({ id: due.id, title: due.title, description: due.description, anonymous: due.anonymous }) : null;
}

export async function getSurveyToFill(id: string) {
  const user = await requireUser();
  const viewer = await me(user.id);
  const now = new Date();

  const survey = await db.survey.findUnique({
    where: { id },
    select: {
      id: true, kind: true, title: true, description: true, anonymous: true, mandatory: true,
      audience: true, status: true, opensAt: true, expiresAt: true,
      targets: { select: { userId: true, departmentId: true } },
      questions: { orderBy: { sortOrder: "asc" } },
      participations: { where: { userId: user.id }, select: { respondedAt: true } },
    },
  });
  if (!survey) return null;
  if (!isTargeted(survey, viewer)) return null;

  return toPlain({
    ...survey,
    open: isAcceptingResponses(survey, now),
    answered: survey.participations[0]?.respondedAt != null,
  });
}

export async function submitResponse(input: {
  surveyId: string;
  answers: { questionId: string; number?: number; text?: string; choices?: string[] }[];
}): Promise<ActionResult<null>> {
  const user = await requireUser();
  const viewer = await me(user.id);
  const now = new Date();

  const survey = await db.survey.findUnique({
    where: { id: input.surveyId },
    select: {
      id: true, title: true, anonymous: true, audience: true, status: true, opensAt: true, expiresAt: true,
      targets: { select: { userId: true, departmentId: true } },
      questions: { select: { id: true, required: true, prompt: true } },
    },
  });
  if (!survey) return { ok: false, error: "That form no longer exists." };
  if (!isTargeted(survey, viewer)) return { ok: false, error: "That form isn't for you." };
  if (!isAcceptingResponses(survey, now)) return { ok: false, error: "That form has closed." };

  const existing = await db.surveyParticipation.findUnique({
    where: { surveyId_userId: { surveyId: survey.id, userId: user.id } },
    select: { id: true, respondedAt: true },
  });
  if (existing?.respondedAt) return { ok: false, error: "You've already answered this one." };

  const given = new Map(input.answers.map((a) => [a.questionId, a]));
  for (const q of survey.questions) {
    if (!q.required) continue;
    const a = given.get(q.id);
    const empty = !a || (a.number === undefined && !a.text?.trim() && (a.choices ?? []).length === 0);
    if (empty) return { ok: false, error: `"${q.prompt}" needs an answer.` };
  }

  await db.$transaction(async (tx) => {
    const response = await tx.surveyResponse.create({
      data: {
        surveyId: survey.id,
        // Date only. No time, no identity — see the model comment.
        submittedOn: submissionDate(now),
        answers: {
          create: input.answers
            .filter((a) => survey.questions.some((q) => q.id === a.questionId))
            .map((a) => ({
              questionId: a.questionId,
              number: a.number ?? null,
              text: a.text?.trim() || null,
              choices: a.choices ?? [],
            })),
        },
      },
      select: { id: true },
    });

    await tx.surveyParticipation.upsert({
      where: { surveyId_userId: { surveyId: survey.id, userId: user.id } },
      create: {
        surveyId: survey.id,
        userId: user.id,
        respondedAt: now,
        // The single link between a person and their answers, and the single branch that writes it.
        // Anonymous surveys never reach the right-hand side of this.
        responseId: survey.anonymous ? null : response.id,
      },
      update: {
        respondedAt: now,
        responseId: survey.anonymous ? null : response.id,
      },
    });
  });

  // No audit entry naming the respondent on an anonymous survey, for the same reason the feedback
  // channel writes none: an audit row and a response row dated the same day are a join.
  if (!survey.anonymous) {
    await recordAudit({
      userId: user.id, action: "CREATE", entityType: "SurveyResponse",
      entityId: survey.id, entityLabel: `Answered ${survey.title}`,
    });
  }

  revalidatePath("/surveys");
  return { ok: true, data: null };
}

/** They pushed the splash away. Recorded so the nag is honest about having been dismissed. */
export async function skipSplash(surveyId: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  await db.surveyParticipation.upsert({
    where: { surveyId_userId: { surveyId, userId: user.id } },
    create: { surveyId, userId: user.id, skippedAt: new Date() },
    update: { skippedAt: new Date() },
  });
  return { ok: true, data: null };
}

// ─── Building and reading them ──────────────────────────────────────────────────────────────────

export async function listSurveys() {
  const user = await requireUser();
  if (!(await manager(user.id))) return null;
  return toPlain(
    await db.survey.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true, kind: true, title: true, anonymous: true, mandatory: true, audience: true,
        status: true, opensAt: true, expiresAt: true, createdAt: true,
        createdBy: { select: { name: true } },
        _count: { select: { questions: true, responses: true, participations: true } },
      },
    }),
  );
}

export async function saveSurvey(input: {
  id?: string;
  kind: SurveyKind;
  title: string;
  description?: string;
  anonymous: boolean;
  mandatory: boolean;
  audience: SurveyAudience;
  status: SurveyStatus;
  opensAt?: string;
  expiresAt?: string;
  targetUserIds?: string[];
  targetDepartmentIds?: string[];
  questions: { id?: string; kind: SurveyQuestionKind; prompt: string; helpText?: string; required: boolean; options: string[] }[];
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  if (!(await manager(user.id))) return { ok: false, error: "You can't create forms." };

  const title = input.title.trim();
  if (!title) return { ok: false, error: "Give it a title." };
  const questions = input.questions.filter((q) => q.prompt.trim());
  if (questions.length === 0) return { ok: false, error: "Add at least one question." };

  const existing = input.id
    ? await db.survey.findUnique({ where: { id: input.id }, select: { anonymous: true, _count: { select: { responses: true } } } })
    : null;
  // Flipping anonymity after people have answered would retrospectively change what they were
  // promised. Refused outright rather than handled.
  if (existing && existing._count.responses > 0 && existing.anonymous !== input.anonymous) {
    return {
      ok: false,
      error: "People have already answered this on the understanding it was " +
        (existing.anonymous ? "anonymous" : "attributed") + ". Close it and start a new one instead.",
    };
  }

  const scalars = {
    kind: input.kind,
    title,
    description: input.description?.trim() || null,
    anonymous: input.anonymous,
    mandatory: input.mandatory,
    audience: input.audience,
    status: input.status,
    opensAt: input.opensAt ? new Date(`${input.opensAt}T00:00:00.000Z`) : null,
    expiresAt: input.expiresAt ? new Date(`${input.expiresAt}T23:59:59.000Z`) : null,
  };

  const survey = input.id
    ? await db.survey.update({ where: { id: input.id }, data: scalars, select: { id: true } })
    : await db.survey.create({ data: { ...scalars, createdById: user.id }, select: { id: true } });

  // Questions and targets are replaced wholesale. Answers store the option *text*, so rewriting a
  // question cannot retrospectively change what somebody chose.
  await db.$transaction(async (tx) => {
    await tx.surveyQuestion.deleteMany({ where: { surveyId: survey.id, id: { notIn: questions.map((q) => q.id ?? "").filter(Boolean) } } });
    for (const op of questions.map((q, i) =>
      q.id
        ? tx.surveyQuestion.update({
            where: { id: q.id },
            data: { kind: q.kind, prompt: q.prompt.trim(), helpText: q.helpText?.trim() || null, required: q.required, options: q.options, sortOrder: i },
          })
        : tx.surveyQuestion.create({
            data: { surveyId: survey.id, kind: q.kind, prompt: q.prompt.trim(), helpText: q.helpText?.trim() || null, required: q.required, options: q.options, sortOrder: i },
          }),
    )) await op;
    await tx.surveyTarget.deleteMany({ where: { surveyId: survey.id } });
    for (const op of (input.audience === "INDIVIDUAL"
      ? (input.targetUserIds ?? []).map((userId) => tx.surveyTarget.create({ data: { surveyId: survey.id, userId } }))
      : [])) await op;
    for (const op of (input.audience === "DEPARTMENT"
      ? (input.targetDepartmentIds ?? []).map((departmentId) => tx.surveyTarget.create({ data: { surveyId: survey.id, departmentId } }))
      : [])) await op;
  });

  await recordAudit({
    userId: user.id, action: input.id ? "UPDATE" : "CREATE", entityType: "Survey",
    entityId: survey.id, entityLabel: title,
  });

  // Told when it opens, not when it is drafted.
  if (scalars.status === "OPEN" && !input.id) {
    const audience = await audienceUsers(survey.id);
    await Promise.all(
      audience.map((id) =>
        notifyUser({
          userId: id,
          type: "SURVEY_ASSIGNED",
          title: `${title} is waiting for you`,
          message: input.anonymous ? "Your answers are anonymous." : "Your answers are attributed to you.",
          link: `/surveys/${survey.id}`,
        }),
      ),
    );
  }

  revalidatePath("/surveys");
  return { ok: true, data: survey };
}

async function audienceUsers(surveyId: string): Promise<string[]> {
  const survey = await db.survey.findUniqueOrThrow({
    where: { id: surveyId },
    select: { audience: true, targets: { select: { userId: true, departmentId: true } } },
  });
  if (survey.audience === "EVERYONE") {
    return (await db.user.findMany({ where: { active: true }, select: { id: true } })).map((u) => u.id);
  }
  if (survey.audience === "INDIVIDUAL") return survey.targets.map((t) => t.userId!).filter(Boolean);
  const departmentIds = survey.targets.map((t) => t.departmentId!).filter(Boolean);
  return (
    await db.user.findMany({ where: { active: true, departmentId: { in: departmentIds } }, select: { id: true } })
  ).map((u) => u.id);
}

export async function setSurveyStatus(id: string, status: SurveyStatus): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await manager(user.id))) return { ok: false, error: "You can't change forms." };
  await db.survey.update({ where: { id }, data: { status } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Survey", entityId: id, entityLabel: `Marked ${status.toLowerCase()}` });
  revalidatePath("/surveys");
  return { ok: true, data: null };
}

export type SurveyResults = {
  id: string;
  title: string;
  anonymous: boolean;
  responseCount: number;
  invited: number;
  /** Who has not answered. Names only, never answers — and only on a survey with an audience. */
  outstanding: string[];
  questions: { id: string; prompt: string; kind: SurveyQuestionKind; result: QuestionResult }[];
};

/**
 * What the answers add up to.
 *
 * Every question goes through `summarise`, which refuses to reveal anything under five responses.
 * The refusal is computed there rather than here so that a second screen — or an export — cannot
 * accidentally skip it.
 */
export async function surveyResults(id: string): Promise<SurveyResults | null> {
  const user = await requireUser();
  if (!(await manager(user.id))) return null;

  const survey = await db.survey.findUnique({
    where: { id },
    select: {
      id: true, title: true, anonymous: true,
      questions: { orderBy: { sortOrder: "asc" }, select: { id: true, prompt: true, kind: true, options: true } },
      responses: { select: { answers: { select: { questionId: true, number: true, text: true, choices: true } } } },
      participations: { select: { respondedAt: true, user: { select: { name: true } } } },
    },
  });
  if (!survey) return null;

  const all = survey.responses.flatMap((r) => r.answers);
  const responseCount = survey.responses.length;

  return {
    id: survey.id,
    title: survey.title,
    anonymous: survey.anonymous,
    responseCount,
    invited: (await audienceUsers(survey.id)).length,
    // Names of people who have not answered. Safe on an anonymous survey — it says who is missing,
    // never what anybody said. On a survey where everybody but one has answered it narrows the one
    // remaining set of answers to one person, which is exactly why results stay hidden under five.
    outstanding: survey.participations.filter((p) => !p.respondedAt).map((p) => p.user.name),
    questions: survey.questions.map((q) => ({
      id: q.id,
      prompt: q.prompt,
      kind: q.kind,
      result: summarise(
        q.kind,
        all.filter((a) => a.questionId === q.id),
        q.options,
        responseCount,
      ),
    })),
  };
}

export async function surveyOptions() {
  await requireUser();
  const [users, departments] = await Promise.all([
    db.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.department.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  return toPlain({ users, departments });
}

export async function deleteSurvey(id: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await manager(user.id))) return { ok: false, error: "You can't delete forms." };
  const survey = await db.survey.findUnique({ where: { id }, select: { title: true, _count: { select: { responses: true } } } });
  if (!survey) return { ok: false, error: "That form no longer exists." };
  if (survey._count.responses > 0) {
    return { ok: false, error: `${survey._count.responses} people have answered this. Close it instead — deleting destroys their answers.` };
  }
  await db.survey.delete({ where: { id } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "Survey", entityId: id, entityLabel: survey.title });
  revalidatePath("/surveys");
  return { ok: true, data: null };
}

export type { Prisma };
