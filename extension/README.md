# WeCode Connect — browser extension

Sideloaded, not published to the Chrome Web Store (see `docs/ARCHITECTURE.md`'s
"Browser Extension" section for why). It's the same `/api/auth/sync` sync
flow the manual-paste form uses — this just skips the copy-paste.

## Build

```
node extension/build.js --env=dev    # points at localhost:3000
node extension/build.js --env=prod   # points at $WECODE_PROD_API_BASE
```

Output lands in `extension/dist/` (gitignored). `--env=prod` fails on
purpose until `WECODE_PROD_API_BASE` is set to a real deployed domain
(Epic 09) — there's nothing to point it at yet.

## Load it (sideload)

1. Run the build (above).
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select `extension/dist`.
5. Pin the WeCode icon, open a `leetcode.com` tab while logged in, then
   click the extension icon and hit **Sync**.

Rebuilding after a code change just needs `node extension/build.js` again —
Chrome picks up the new `dist/` contents on the extensions page's reload
button (or reopening the popup for JS-only changes).
