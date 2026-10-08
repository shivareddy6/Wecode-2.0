import { createClient } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/dal";
import { LeetCodeSyncForm } from "@/components/leetcode-sync-form";
import { ReconnectLeetCode } from "@/components/reconnect-leetcode";
import { Avatar } from "@/components/avatar";
import { createRoom } from "@/app/rooms/actions";

// Public landing page: the manual-paste sync flow (Epic 01, Story 5) is the
// only thing here right now, since rooms/dashboard don't exist yet. Checks
// auth state directly via getUser() rather than verifySession() — this page
// must render for signed-out visitors, not redirect them.
export default async function Home() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-background font-sans">
      <main className="flex w-full max-w-md flex-1 flex-col items-center justify-center gap-8 px-6 py-16">
        <h1 className="text-2xl font-semibold tracking-tight">
          We<span className="text-accent">Code</span>
        </h1>

        {data.user ? (
          <SignedInCard />
        ) : (
          <>
            <p className="text-center text-sm text-muted">
              Sync your LeetCode session to create your WeCode account — no
              separate signup.
            </p>
            <LeetCodeSyncForm />
          </>
        )}
      </main>
    </div>
  );
}

async function SignedInCard() {
  const user = await getCurrentUser();

  return (
    <div className="flex w-full flex-col items-center gap-2 rounded-lg border border-border bg-panel p-6 text-center">
      <Avatar
        avatarUrl={user.avatarUrl}
        displayName={user.displayName}
        username={user.leetcodeUsername}
        className="h-16 w-16 text-lg"
      />
      <p className="text-sm text-muted">Connected as</p>
      <p className="text-lg font-medium">
        {user.displayName ?? user.leetcodeUsername}
      </p>
      <form action={createRoom} className="mt-6">
        <button
          type="submit"
          className="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-accent-foreground hover:bg-accent-hover"
        >
          Create a room
        </button>
      </form>
      <div className="mt-4">
        <ReconnectLeetCode />
      </div>
    </div>
  );
}
