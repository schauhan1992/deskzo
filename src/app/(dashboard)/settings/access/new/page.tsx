import { redirect } from "next/navigation";

/** Add staff moved to Users ("+"): a saved link still lands on the form, which checks its own permissions. */
export default function RetiredAddStaffPage() {
  redirect("/settings/users/new");
}
