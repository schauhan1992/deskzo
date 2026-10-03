import type { StaffStatus } from "@/lib/staff/status";
import type { ModuleState } from "@/lib/staff/permission-modules";

/**
 * The shapes Staff & roles hands its client components: plain, serialisable, and built on the server
 * by src/app/(dashboard)/settings/access/page.tsx from the actions it already used.
 */

/** One person in the Staff table. */
export type StaffRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  /** The role's display name; the key when the role has gone. */
  roleName: string;
  isSuperAdmin: boolean;
  status: StaffStatus;
  active: boolean;
  /** No password chosen yet (src/lib/account-setup.ts). */
  setupPending: boolean;
  /** A setup link was issued before, so the button says "Resend". */
  setupLinkIssued: boolean;
  /** Signing in with a temporary password an admin reset theirs to, until they choose their own. */
  tempPassword: boolean;
  photoUpdatedAt: string | null;
  jobTitle: string | null;
  phone: string | null;
  departmentId: string | null;
  departmentName: string | null;
  managerId: string | null;
  managerName: string | null;
  /** "Works at", when the company has more than one branch and the viewer may set it. */
  branchId: string | null;
  twoFactorOn: boolean;
  /** How many of the catalogue's permissions they hold, from the resolver. */
  holds: number;
  total: number;
  exceptions: number;
  lapsingSoon: boolean;
  /** Null when the viewer may not see leads. */
  openLeads: number | null;
  overdueLeads: number | null;
  /** Null when never, or when the viewer may not see sign-ins (see `showSignIns`). */
  lastSignIn: { label: string; exact: string; iso: string } | null;
  isYou: boolean;
};

export type RoleChoice = { key: string; name: string };

export type DepartmentChoice = { id: string; name: string };

/** A branch somebody can be said to work at. An inactive one appears only while somebody still does. */
export type WorkBranch = { id: string; name: string; code: string; isHeadOffice: boolean; active: boolean };

/** One permission as the role dialog shows it. */
export type CatalogueEntry = {
  key: string;
  label: string;
  description: string;
  group: string;
  tier: string;
  superAdminOnly: boolean;
  /** The modules it does nothing without (src/lib/staff/permission-modules.ts). */
  modules: string[];
};

/** One role card, and what the dialog opens with. */
export type RoleCard = {
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  /** Everybody holding it, switched off or not — what decides whether it can be deleted. */
  headcount: number;
  /** Active holders, as the card's "N staff" — the super admin counted on their own card, not Admin's. */
  activeStaff: number;
  /** The keys it grants, as the resolver reads the role (registry default, or a stored answer). */
  held: string[];
};

export type ModuleStates = Record<string, ModuleState>;
