import "dotenv/config";

// Fails fast on startup if anything required is missing, rather than
// surfacing as a confusing runtime error on the first connection.

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4001),
  supabaseUrl: required("SUPABASE_URL"),
  supabasePublishableKey: required("SUPABASE_PUBLISHABLE_KEY"),
  supabaseJwtSecret: required("SUPABASE_JWT_SECRET"),
  internalSecret: required("REALTIME_INTERNAL_SECRET"),
  allowedOrigin: process.env.ALLOWED_ORIGIN ?? "http://localhost:3000",
};
