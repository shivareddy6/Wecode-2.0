import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

// Next.js renamed middleware.ts -> proxy.ts as of v16; same job, same
// NextRequest/NextResponse API. See ARCHITECTURE.md's "Next.js 16
// patterns" section.
//
// This calls supabase.auth.getUser() rather than just reading the cookie,
// which looks like it contradicts the "keep proxy checks optimistic/
// cookie-only" guidance from Next's own auth docs. It doesn't: this is
// Supabase's own documented middleware pattern, and the getUser() call
// here is doing double duty — it's also what refreshes an expiring
// Supabase session token and writes the renewed cookie back onto the
// response. Skipping it would mean sessions silently expire mid-use.
// The DAL (lib/dal.ts) is still the real authorization boundary for data
// access; this is route-level redirect UX, not the security check itself.
export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const { data } = await supabase.auth.getUser();
  const isAuthenticated = Boolean(data.user);

  // Route groups don't exist yet beyond the placeholder home page — this
  // list grows as real protected routes (rooms, solve, dashboard) land.
  // Kept as an explicit allowlist of PUBLIC prefixes (rather than a
  // protected-prefix list) so a newly added route defaults to protected
  // unless someone deliberately opens it up.
  const publicPrefixes = ["/", "/demo", "/api/auth/sync", "/api/auth/status"];
  const isPublicRoute = publicPrefixes.some(
    (prefix) =>
      request.nextUrl.pathname === prefix ||
      (prefix !== "/" && request.nextUrl.pathname.startsWith(prefix)),
  );

  // Epic 04, Story 2 — a room's invite link (/rooms/[code], exactly one
  // segment past /rooms/) has to be reachable while logged out: that page
  // is what shows the LeetCode sync form to a signed-out visitor before
  // completing their join. This intentionally does NOT match anything
  // deeper (e.g. /rooms/[code]/solve/[slug]) — those stay behind the
  // normal redirect-to-"/" here, same as before. The page itself (and the
  // DAL underneath it) still does the actual authorization check; this is
  // only route-level redirect UX, per the comment at the top of this file.
  const isRoomJoinRoute = /^\/rooms\/[^/]+\/?$/.test(request.nextUrl.pathname);

  if (!isAuthenticated && !isPublicRoute && !isRoomJoinRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
