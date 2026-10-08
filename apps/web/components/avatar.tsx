"use client";

import { useState } from "react";
import { hasRealAvatar, getInitials } from "@/lib/format/avatar";

// One avatar-or-initials renderer, used everywhere a person shows up
// (participants, chat, the profile menu) instead of duplicating the same
// img-vs-initials branch three times. onError covers what the URL-based
// hasRealAvatar check can't: a genuinely broken/expired image link — that
// still falls back to initials instead of a broken-image glyph, it just
// can't be known until the browser actually tries to load it.
export function Avatar({
  avatarUrl,
  displayName,
  username,
  className = "h-6 w-6 text-xs",
}: {
  avatarUrl: string | null;
  displayName: string | null;
  username: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (hasRealAvatar(avatarUrl) && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- avatar URLs are arbitrary LeetCode-hosted images, not project assets next/image can optimize.
      <img
        src={avatarUrl}
        alt=""
        onError={() => setFailed(true)}
        className={`shrink-0 rounded-full ${className}`}
      />
    );
  }

  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full bg-panel-raised font-medium text-muted ${className}`}
    >
      {getInitials(displayName, username)}
    </span>
  );
}
