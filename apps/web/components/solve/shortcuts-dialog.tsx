"use client";

import * as Dialog from "@radix-ui/react-dialog";

const SHORTCUTS: [string, string][] = [
  ["⌘ ⏎", "Submit"],
  ["⌘ '", "Run"],
  ["⌘ J", "Toggle the testcase/result panel"],
  ["⌘ B", "Toggle chat/participants"],
  ["⌘ ⇧ L", "Open the leaderboard"],
];

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60" />
        <Dialog.Content className="fixed top-1/2 left-1/2 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-panel p-6">
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-lg font-semibold">Keyboard shortcuts</Dialog.Title>
            <Dialog.Close className="text-sm text-muted hover:text-foreground">Close (Esc)</Dialog.Close>
          </div>
          <ul className="flex flex-col gap-2 text-sm">
            {SHORTCUTS.map(([keys, label]) => (
              <li key={label} className="flex items-center justify-between gap-4">
                <span className="text-foreground">{label}</span>
                <kbd className="rounded border border-border bg-panel-raised px-2 py-0.5 font-mono text-xs">{keys}</kbd>
              </li>
            ))}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
