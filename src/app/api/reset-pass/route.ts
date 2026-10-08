import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { getTenantDb } from "../../../lib/db";
import { legacyTenant } from "../../../lib/tenancy/registry";
import { runAsTenant } from "../../../lib/tenancy/resolve";

export async function GET() {
  try {
    const tenant = await legacyTenant();
    if (!tenant) return NextResponse.json({ error: "Workspace not found" });
    
    await runAsTenant(tenant, async () => {
      const tenantDb = await getTenantDb();
      const hash = await bcrypt.hash("Sachin@Deskzo#567", 10);
      
      await tenantDb.user.update({
        where: { email: "sachin@wroffy.com" },
        data: { passwordHash: hash }
      });
    });
    
    return NextResponse.json({ success: true, message: "Password reset successful!" });
  } catch (error) {
    return NextResponse.json({ error: String(error) });
  }
}
