-- Defining a role is now something somebody does, so it needs somewhere to be recorded.
--
-- `permission_changes` already carries who put whom into a role; it had no way to say who created
-- the role in the first place, because until roles became data that was a deploy rather than an act.
--
-- Added rather than used in the same migration: Postgres allows ALTER TYPE ... ADD VALUE inside a
-- transaction, but not using the new value in that same transaction, and Prisma wraps each
-- migration in one.
ALTER TYPE "PermissionChangeKind" ADD VALUE 'ROLE_CREATED';
ALTER TYPE "PermissionChangeKind" ADD VALUE 'ROLE_RENAMED';
ALTER TYPE "PermissionChangeKind" ADD VALUE 'ROLE_DELETED';
