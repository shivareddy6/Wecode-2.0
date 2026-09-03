import { createClient } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/dal";
import { LeetCodeSyncForm } from "@/components/leetcode-sync-form";

// Public landing page: the manual-paste sync flow (Epic 01, Story 5) is the
// only thing here right now, since rooms/dashboard don't exist yet. Checks
// auth state directly via getUser() rather than verifySession() — this page
// must render for signed-out visitors, not redirect them.
export default async function Home() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  return (
    <div className="flex flex-col flex-1 items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex flex-1 w-full max-w-md flex-col items-center justify-center gap-8 px-6 py-16">
        <h1 className="text-2xl font-semibold tracking-tight">WeCode</h1>

        {data.user ? (
          <SignedInCard />
        ) : (
          <>
            <p className="text-center text-sm text-zinc-600 dark:text-zinc-400">
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
    <div className="flex flex-col items-center gap-2 text-center">
      {user.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={user.avatarUrl}
          alt=""
          className="h-16 w-16 rounded-full"
        />
      ) : null}
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Connected as
      </p>
      <p className="text-lg font-medium">
        {user.displayName ?? user.leetcodeUsername}
      </p>
    </div>
  );
}
