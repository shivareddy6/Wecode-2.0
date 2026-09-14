import { jwtVerify } from "jose";
import { env } from "./env.js";

// Verifies a Supabase-issued access token locally against the project's
// legacy JWT secret (HS256) — no round trip to Supabase's Auth server per
// connection. See .env.example's SUPABASE_JWT_SECRET comment and
// docs/epics/11-realtime-server.md for why this is HS256 and not the
// newer JWKS/asymmetric-key scheme: this project's JWKS endpoint returns
// an empty key set, so it's still on the shared secret.
const secretKey = new TextEncoder().encode(env.supabaseJwtSecret);

export type VerifiedUser = {
  userId: string;
};

export async function verifyAccessToken(
  token: string,
): Promise<VerifiedUser> {
  const { payload } = await jwtVerify(token, secretKey, {
    algorithms: ["HS256"],
  });

  // aud "authenticated" is what Supabase stamps on real user session
  // tokens (as opposed to e.g. a service-role token) — checked explicitly
  // rather than trusting signature validity alone.
  if (payload.aud !== "authenticated" || typeof payload.sub !== "string") {
    throw new Error("Token is not a valid Supabase user session");
  }

  return { userId: payload.sub };
}
