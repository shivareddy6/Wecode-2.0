"use client";

import Link from "next/link";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { signOut } from "@/app/actions";
import { Avatar } from "@/components/avatar";

const ITEM_CLASS = "block w-full cursor-pointer rounded-md px-3 py-1.5 text-left text-sm outline-none hover:bg-panel-raised data-[highlighted]:bg-panel-raised";

export function ProfileMenu({
  displayName,
  leetcodeUsername,
  avatarUrl,
  onShowShortcuts,
}: {
  displayName: string | null;
  leetcodeUsername: string;
  avatarUrl: string | null;
  onShowShortcuts?: () => void;
}) {
  const name = displayName || leetcodeUsername;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" title={name} className="shrink-0 rounded-full">
          <Avatar avatarUrl={avatarUrl} displayName={displayName} username={leetcodeUsername} className="h-7 w-7 text-xs" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className="min-w-56 rounded-md border border-border bg-panel p-1 shadow-lg"
        >
          <div className="px-3 py-2">
            <p className="text-sm font-medium">{name}</p>
            <p className="text-xs text-muted">{leetcodeUsername}</p>
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />

          {onShowShortcuts ? (
            <DropdownMenu.Item onSelect={onShowShortcuts} className={ITEM_CLASS}>
              Keyboard shortcuts
            </DropdownMenu.Item>
          ) : null}
          <DropdownMenu.Item asChild>
            <Link href="/" className={ITEM_CLASS}>
              Reconnect LeetCode
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild>
            <a href={`https://leetcode.com/u/${leetcodeUsername}/`} target="_blank" rel="noreferrer" className={ITEM_CLASS}>
              View LeetCode profile
            </a>
          </DropdownMenu.Item>

          <DropdownMenu.Separator className="my-1 h-px bg-border" />

          <DropdownMenu.Item asChild>
            <form action={signOut}>
              <button type="submit" className={`${ITEM_CLASS} text-danger`}>
                Log out
              </button>
            </form>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
