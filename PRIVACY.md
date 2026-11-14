# Awesome bookmarks: privacy policy

*Last updated: 14 November 2026*

Awesome bookmarks replaces Chrome's new tab page with your bookmarks laid out as an app grid. It has no servers, no analytics, no ads and no tracking. The developer never receives any of your data.

## What it reads, and where that data stays

| Data | Why | Where it goes |
|---|---|---|
| Your bookmarks | To show them on the new tab, and to add, edit, move and delete them when you ask | Stays in Chrome. Chrome syncs bookmarks itself if you have sync on. |
| Settings and tasks | To remember your layout, wallpaper choice, widgets and to-do list | `chrome.storage.sync`: your Chrome profile, synced by Google to your other computers if Chrome sync is on |
| Your own wallpaper image | To show it behind the grid | `chrome.storage.local` on this computer, plus your Google Drive if you turn on Drive sync |
| Pictures or emoji you choose for bookmarks | To show them as those bookmarks' icons | `chrome.storage.local` on this computer, plus your Google Drive if you turn on Drive sync |
| Google Drive *(optional)* | Only if you click Connect under Backup, to sync your icons and wallpaper image | One file in Drive's hidden app folder (`drive.appdata` scope): the extension can't see anything else in your Drive. It holds your chosen icons, by bookmark address, and your wallpaper image. Remove it from your Google Account's third-party access page. |
| Browsing history *(optional)* | Only when you open "Add from history", to let you pick pages to bookmark | Read on this computer. Never stored or sent. |
| Most-visited sites *(optional)* | Only if you switch on "Frequent sites" | Read on this computer. Never stored or sent. |
| Google Calendar *(optional)* | Only if you click Connect, to show your next meeting today | Read-only access. Events are requested from Google and shown on the page, never stored. Chrome keeps the sign-in token; Disconnect revokes it at Google. |
| Website access *(optional)* | Only while "Check broken links" runs | Each bookmarked public page gets one request, without cookies, to see whether it still exists. Addresses on your own computer or local network are never checked. Access is given back when the check ends. |

## What it sends

- **To Google:** calendar requests and token revocation, only if you connect Google Calendar; your icons and wallpaper image, to your own Drive, only if you connect Drive sync.
- **To the sites you bookmarked:** one request each, only when you run "Check broken links".
- **Nothing else.** Favicons come from Chrome's own local cache.

## Backups

"Back up" saves your settings and tasks to a file on your computer. Nothing is uploaded.

## Contact

Questions: open an issue on the project's GitHub page.
