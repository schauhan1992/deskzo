-- A role switched off or back on, in the permission history (src/actions/role.ts `setRoleActive`).
-- Expand-only: two new values of an enum nothing yet writes.
ALTER TYPE "PermissionChangeKind" ADD VALUE IF NOT EXISTS 'ROLE_DEACTIVATED';
ALTER TYPE "PermissionChangeKind" ADD VALUE IF NOT EXISTS 'ROLE_ACTIVATED';
