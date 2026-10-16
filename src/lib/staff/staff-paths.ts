/** Where a role and a person open on the Roles & Permissions and Users screens. */
export const rolePath = (key: string, tab?: string) => `/settings/roles?role=${encodeURIComponent(key)}${tab ? `&tab=${tab}` : ""}`;
export const userPath = (id: string, tab?: string) => `/settings/users?user=${encodeURIComponent(id)}${tab ? `&tab=${tab}` : ""}`;
