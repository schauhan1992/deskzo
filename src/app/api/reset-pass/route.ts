import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    // Naya Prisma connection jo app ke workspace/middleware rules ko bypass karta hai
    const prisma = new PrismaClient();
    const hash = await bcrypt.hash("NewPassword123!", 10);
    
    await prisma.user.update({
      where: { email: "sachin@wroffy.com" },
      data: { passwordHash: hash }
    });
    
    await prisma.$disconnect();
    return NextResponse.json({ success: true, message: "Password reset successful! You can login now." });
  } catch (error) {
    return NextResponse.json({ error: "Error details: " + String(error) });
  }
}
