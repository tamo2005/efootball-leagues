import { bootstrapAdmin } from "../server/auth";

const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
const displayName = process.env.BOOTSTRAP_ADMIN_NAME || "League Administrator";
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;

if (!email || !password) {
  throw new Error("BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD are required.");
}

const user = await bootstrapAdmin(email, displayName, password);
console.log(`Administrator ready: ${user?.email}`);
