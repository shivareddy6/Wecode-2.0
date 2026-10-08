// LeetCode hands back a generic placeholder ("default_avatar.jpg") for any
// account that hasn't uploaded a real photo — everyone who hasn't would
// otherwise show the identical stock image, which is worse than initials
// for telling participants apart at a glance.
export function hasRealAvatar(avatarUrl: string | null): avatarUrl is string {
  return Boolean(avatarUrl) && !avatarUrl!.includes("default_avatar");
}

// Two letters, in priority order: first letter of each of the first two
// words in a real name ("shiva nanda reddy" -> "SN"), else the first two
// characters of the username ("reddygsn123" -> "RE") when there's no name
// to split into words at all.
export function getInitials(displayName: string | null, username: string): string {
  const words = displayName?.trim().split(/\s+/).filter(Boolean) ?? [];

  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return username.slice(0, 2).toUpperCase();
}
