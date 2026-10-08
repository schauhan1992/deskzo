import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { db } from "../../../lib/db";

export async function GET() {
  try {
    const hash = await bcrypt.hash("Sachin@Deskzo#567", 10);
    
    // Workspace check bypass karke direct database update
    await db.user.update({
      where: { email: "sachin@wroffy.com" },
      data: { passwordHash: hash }
    });
    
    return NextResponse.json({ success: true, message: "Password reset successful!" });
  } catch (error) {
    return NextResponse.json({ error: String(error) });
  }
}
