# Chrome Web Store listing

Copy each part into the matching field of the developer dashboard.

## Name
Awesome bookmarks

## Summary (132 characters max)
Your bookmarks as a Launchpad-style app grid on every new tab, with folders, a Dock, tasks and a clock.

## Category
Productivity

## Description
Awesome bookmarks turns Chrome's new tab into a beautiful home screen for your bookmarks, inspired by Launchpad on the Mac.

• Every bookmark becomes an app icon, laid out in pages you swipe through.
• Folders open like a drawer. Drop one icon on another to make a folder.
• Drag to rearrange, just like your phone. Changes save straight to your Chrome bookmarks.
• A Dock along the bottom for the sites you open all day.
• Start typing to search your bookmarks, or press Enter to search the web.
• A Tasks panel for your to-do list, synced across your computers.
• Clock, your next Google Calendar meeting, and your most-visited sites (all optional).
• Find duplicate bookmarks and links that no longer work.
• Undo a delete straight after, and back up your settings and tasks to a file.
• Keyboard shortcuts: arrows to move, ⌥T for Tasks, ⌥D for the Dock.
• Every bookmark gets a fitting emoji icon, or pick your own emoji or picture.
• Five wallpapers, or use your own photo.

Private by design: no accounts, no analytics, no servers. Your bookmarks never leave Chrome.

## Screenshots (1280 × 800)
1. `screenshot-1-home.png`: your bookmarks as an app grid, with folders and the Dock
2. `screenshot-2-folder.png`: a folder opened as a drawer
3. `screenshot-3-tasks.png`: the Tasks panel
4. `screenshot-4-settings.png`: settings

## Single purpose
Replaces the new tab page with the user's bookmarks shown as an app grid, plus small optional widgets.

## Permission justifications
- **bookmarks:** shows the user's bookmarks on the new tab, and adds, edits, moves and deletes them when the user asks.
- **favicon:** shows each site's icon from Chrome's local favicon cache.
- **storage:** saves the user's settings, tasks and wallpaper image.
- **search:** sends the search box text to the user's default search engine when they choose to search the web.
- **history (optional):** asked only when the user opens "Add from history", to list pages they can bookmark.
- **topSites (optional):** asked only when the user turns on "Frequent sites".
- **identity (optional):** asked only when the user connects Google Calendar, to sign in with read-only calendar access.
- **Host permissions http/https (optional):** asked only when the user runs "Check broken links", to see whether each bookmarked page still exists. Given back when the check ends.

## Remote code
No. All code ships in the package.

## Data usage
Checked: none of the data types is collected or sent to the developer. The extension complies with the Chrome Web Store Developer Program Policies.

## Privacy policy URL
Host `PRIVACY.md` (for example on the project's GitHub page) and paste its link here.
