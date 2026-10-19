• The app is a static, browser-only mind-map editor. It looks polished on desktop, but there is no login system, backend, cloud storage, or account isolation.

  ## Where the maps are stored

  Maps are called “boards” and are serialized into browser localStorage:

  - mindgraph_boards: every board, node, connection, group, and viewport.
  - mindgraph_active: the active board ID.

  The implementation is in app.js:938, with the stored shape defined around app.js:987.

  Consequences:

  - Boards exist only in that browser profile and website origin.
  - Changing hostname, port, protocol, browser, or device makes them appear missing.
  - Clearing site data deletes everything.
  - Private browsing may discard everything.
  - There is no export/import, backup, synchronization, or recovery.
  - The in-memory fallback is nonpersistent and can silently lose work if storage is unavailable or full.

  ## Important findings

  1. There is no login or authentication

     No account, session, API, backend, or authorization code exists. Every visitor gets an independent local dataset. Anyone using the same browser profile can see the notes.

     Adding a login screen alone would not fix this—a real implementation needs server-side users, authenticated storage, authorization checks, and migration of existing local
     boards.

  2. Board switching can lose recent changes

     loadBoard() updates the previous board only in memory before switching, but does not immediately serialize it to localStorage (app.js:953). Persistence may not occur until
     the ten-second autosave at app.js:1419. Switching and then closing the tab quickly can lose changes.

  3. Selecting a connection can accidentally delete nodes

     Clicking a connection clears only selectedConnections; previously selected nodes remain selected (app.js:466). deleteSelected() then deletes both the selected connection and
     all selected nodes (app.js:839). The context menu also shows node-only actions while a connection is selected.

  4. Canvas coordinates are vertically offset

     screenToWorld() treats viewport coordinates as canvas-relative without subtracting the 44px toolbar (app.js:258). This affects double-click node placement, rectangle
     selection, zoom pivots, temporary connection lines, and fit-to-view calculations. Nodes can appear noticeably below the cursor.

  5. Mobile layout is broken

     At 390px wide, the toolbar simply runs offscreen: Connect, Group, Delete, and zoom controls become inaccessible. There are no responsive media queries. The editor also
     remains a two-column layout, leaving each pane impractically narrow.

  6. Storage failures are silent

     Failed writes are caught without notifying the user (app.js:15, app.js:999). When quota is exceeded, the UI can appear to save correctly while reload restores older data.

  7. Third-party scripts can access locally stored notes

     KaTeX, Marked, and CodeMirror execute from public CDNs (index.html:150). Marked is not version-pinned, and none of the scripts use integrity hashes. Because these scripts
     execute in the application origin, a compromised dependency could read the boards from localStorage.

  8. Accessibility needs attention

     Board switching and renaming are click-only spans, board action buttons appear only on hover, several icon buttons have no accessible name, and there are almost no visible
     keyboard focus styles. The canvas itself has no semantic representation for assistive technology.

  9. Vim mode is mandatory

     CodeMirror always starts with keyMap: 'vim' (codemirror-editor.js:26). Unless this is strictly a personal preference, users may click the editor and find that normal typing
     does not work, with no toggle or onboarding.

  ## Codebase overview

  - index.html: entire interface and remote dependencies.
  - style.css: desktop-oriented dark theme and layout.
  - app.js: rendering, interactions, board management, markdown/math, and persistence.
  - codemirror-editor.js: optional CodeMirror/Vim wrapper with textarea fallback.
  - No build system, application server, database, tracked automated tests, or deployment configuration.

  I rendered it at desktop and mobile sizes and exercised node creation, dragging, modal editing, Markdown/KaTeX rendering, and selection behavior. JavaScript syntax checks pass
  and I found no immediate startup exception; the only routine browser request failure was a missing favicon. I made no code changes.
