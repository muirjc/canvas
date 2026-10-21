# Canvas UI consistency review (2026-10-21)

Screenshots (1280x800 unless noted), all in this directory: admin-overview.png, admin-standards.png, admin-users.png, admin-deleted.png, admin-ai-personas.png, project-list.png, project-page.png, editor.png, m2-project-list.png and m2-project-page.png (390px). Ignore the m-*.png files, which are stale.
No app code, specs or docs were changed. The throwaway spec was deleted.

## Part 1 - canvas-513: header "Projects" does nothing on admin pages

**Cause confirmed by reading the code.**
- `parseLocation('?admin=x')` returns `{screen:'projects'}`, because no projectId is present.
- `navigate()` in App.tsx:163 sees `sameLocation(from, to)`, so it pushes nothing.
- `applyLocation` sets an identical state value, so React bails out.
- App decides "admin or Browse" from `window.location.search` at render (App.tsx:144, 375), and that is never cleared. The screen therefore never changes.

**Options, from the user's point of view**

| | (a) navigate() treats admin as different | (b) Projects is a plain link on admin pages | (c) admin becomes a Location |
|---|---|---|---|
| Fixes the bug | Yes | Yes | Yes |
| Header behaves the same everywhere | Yes | Mostly. It is a full reload, with a flash and a re-fetch of me/projects/shared. | Yes |
| Browser Back from Browse to admin | Entering admin is a full load, so Back works, but re-entering is a reload | Same | Fully consistent, no reloads |
| Back from admin to Browse | Works, because `pushState('/')` is then a real entry | Works (a real page load) | Works |
| aria-current | Already correct (`currentSection==='admin'`) | Same | Same |
| Effort and risk | About 5 lines. Low risk. | About 5 lines in AppShell. Low risk, but it entrenches the two navigation models. | Medium. Adds a screen to `Location`, `locationToSearch` and the history and popstate guard, and moves the `adminParam` reads. A role check on popstate is also needed. Admin pages are separate components with their own fetches, so there is no editor-guard interaction. |

**Recommendation: (a) now, and file (c) as a follow-up only if more admin work is planned.**
- The fix is that `navigate()` must compare against the real address, not just `locationRef`. The simplest form is: if `new URLSearchParams(window.location.search).has('admin')`, treat `from` as different. Then push the address, clear the admin param, and the next render shows Browse.
- Better still, make `adminParam` React state, or derive it from `location`. Without that, `adminParam` stays a render-time read of `window.location`, which is the real fragility. Today it only re-renders because something else happens to set state.
- Popstate has the same trap. Back from `?admin=` to `/` works only because `applyLocation` is called with a new object. Test Forward and Back across admin and Browse in the e2e, which is the bead's acceptance criterion.
- (b) is the weakest. It makes the header behave differently by screen, which is the exact complaint, and it throws away the SPA state.
- (c) is the principled end state. Admin is entered by a full-page link and admin pages are leaf screens, so the cost is not justified by this bug alone.

**Should the admin "Back" link stay?** No. Remove it once Projects works.
- It duplicates the header's Projects link. Its target ("last Browse location in this tab") is a clever behaviour, but it is invisible to the user and unlike every other Back in the app.
- The editor's back button is different. It names its destination and does work the header cannot do (the project, not the list).
- If you want the "return to where I was" behaviour, make the header's Projects link on admin pages go to `readLastBrowseHref()`. That is one rule, in one place, and it would also fix a discoverability problem: "Back" sits left of the tab row as if it were a tab.
- This means removing `admin-nav__back` from AdminShell.tsx:41-46 and the `admin-back-to-diagrams` test id from the e2e specs. The id is itself a stale name.

## Part 2 - consistency review

### The owner's example: Overview's "Manage Standards / Manage Users" links

**Redundant. Remove them.**
- Both links duplicate the top tabs (Standards, Users) and sit directly under them (admin-overview.png).
- They cover only 2 of the 5 other destinations, so they are also incomplete.
- Design doc §4 already reasoned that the side nav lists every admin page, so the page-level links add nothing.
- Why the page exists at all: FR-023 "single place to manage". The tabs now deliver that, so Overview is the weak part.

**What Overview should be instead.** Make the three counts the links. Turn each stat into a card with the number, a label, and an "Open" or the number itself as a link to its page.
- Users 3, links to Users.
- Standards 19 published / 123 total, links to Standards.
- Libraries 5. This has no admin page, so it stays static text and we do not invent one.
- This is the only thing a landing page adds: at-a-glance state plus a shortcut.
- Optionally add "needs attention" figures. Examples are deleted diagrams awaiting purge and standards still in draft. Only do this if the API already returns them.
- If that is more than wanted, the minimal fix is to delete the `<nav>` in AdminOverview.tsx:30-37 and leave the stats list.
- Related: the first screenshot shows the stats rendered as a bare `<dl>` that fills 25% of an empty page. Use the `.card` primitive and the existing grid utilities.

### Findings

**Must-fix**

1. **Admin pages have no page identity.**
   - `document.title` stays "Projects – Canvas" on every admin page (App.tsx:279-283 ignores `adminParam`).
   - No admin page has an `<h1>`. They use `<h2>` (AdminOverview.tsx:19, UsersPage.tsx:18, DeletedDiagramsPage.tsx:48 and others), under no `<h1>`. StandardsEditor then jumps `h2` > `h3` > `h4`, and the screen-reader outline starts at level 2.
   - The focus-to-heading after navigation does not run (there is no `data-browse-heading`).
   - Fix: promote the page title to `<h1 className="page__title" tabIndex={-1} data-browse-heading>` in each admin page, or render it once in AdminShell from a `title` prop. Set `document.title` to "<Page> – Admin – Canvas".
   - This is an accessibility failure, not a taste issue.
2. **Phone layout is broken.** At 390px (m2-project-list.png, m2-project-page.png) the document is 1280px wide (`scrollWidth` measured 1280).
   - The list row overflows, so Open/Rename/Delete are cut off or reachable only by sideways scroll. The filter and New Project row is also clipped.
   - The design doc promised that "row buttons wrap onto a second line", and that is not what happens.
   - There is also only one `@media` query in the CSS (`.std-layout`).
   - Likely cause: a min-content blowout from a long unbreakable name plus a no-wrap actions group, or a fixed-width grid in layout.css. I did not trace the exact element.
   - Fix: `min-width: 0` on the row's text cell, `flex-wrap: wrap` on `.project-node` and its actions, and a 640px breakpoint.
   - Also check the header at 390px. The wordmark, two links, email and Sign Out fit only barely, and the email should hide below about 600px.
3. **Admin Back (above) and the dead header link.** Fixed through Part 1.

**Should-fix**

4. **Four "ways up" with four different labels.**
   - Header "Projects" (always the list).
   - Breadcrumb "Projects ›" (the same target as the header link, on the project page).
   - Editor "‹ <Project name>" (a different target, and it deliberately differs).
   - Admin "Back" (a fourth meaning).
   - Judgement: the first three are appropriate, since each names its destination, which is good wayfinding. The admin "Back" is the odd one out and goes (see Part 1).
   - The breadcrumb on a single-level hierarchy is arguably redundant with the header's Projects link. But it is the standard pattern, it gives the page a "you are here" cue, and it costs a single line. Leave it.
5. **Row action styling differs between the two lists.** The project list uses icon plus text and wraps Delete in a faded disabled style (project-list.png). The diagram list uses plain text actions with no icons (project-page.png). They are the same pattern (a `btn--tertiary` row), so give them the same treatment.
   - Recommendation: either add the icons to the diagram rows' Open/Move/Delete, or drop them from the project rows. Dropping them is the cheaper way to unify. Files: ProjectsPage.tsx:236-259, ProjectBrowser.tsx:40-60.
   - The disabled Delete is also very faint, which reads as a rendering glitch. Keep the explanation as visible helper text or at least a stronger title, since a hover-only title does not help touch or keyboard users.
6. **The project list's name is a link, and so are Open and Rename.** There are three blue elements per row (screenshot). The name link is fine (per design). To reduce visual noise, make Open a `btn--secondary`, or drop it, since the name link already does the same thing. Keep "Open" only if you want the always-visible explicit action the spec insists on.
7. **Primary-action position is inconsistent.**
   - Projects: "New Project" sits at the right of the filter row.
   - Project page: the four create buttons sit left-aligned under the title, with New Diagram primary.
   - Editor: Save is primary at the far right.
   - Admin pages: primary actions such as Create persona appear inline in the form.
   - Judgement: acceptable, because each is the natural spot for its screen. The one real mismatch is the project page, where the page-level action row sits above search/filter, while on the Projects page the action sits next to the filter. Pick one: put the create row in the same place relative to the filter on both.
8. **Four create buttons on the project page, and a duplicated "new project" form.** The empty state (App.tsx:498-526) is a hand-rolled form with a different layout from the New Project form on ProjectsPage. It is out of the common component, so it will drift. The design doc said it would be "the same component".
9. **Naming drift.**
   - Test ids still say "Back to diagrams" (`admin-back-to-diagrams`, `project-browser-*`) even though the UI no longer does.
   - The editor's back button aria-label is "Back to Projects" for the shared-diagram case, which reads as the page, not as the "Diagrams" default it replaces. The `backLabel = 'Diagrams'` default in DiagramEditor.tsx:59 is dead and should go.
   - Header "Projects" versus admin "Deleted Projects": fine. "Deleted Diagrams" and "Deleted Projects" should read as one "Trash" section, but that is an IA change, not a bug. Only worth doing if the list of tabs grows.
10. **AI mock-mode note placement** (App.tsx:567-571).
   - It sits inline in the create-actions row, after "Create with AI", as small grey text. It is easy to miss, and on narrow screens it will wrap awkwardly.
   - It is also shown to all users on every project page. The chat panel has its own notice (ChatPanel.tsx:143), so the same fact is stated in two places.
   - Recommendation: show it only where the AI is used (the Create with AI dialog and the chat panel), or, if it must be global, as a one-line banner under the header visible to admins only. The disabled-AI note beside it has the same issue.

**Leave as-is**

11. **Header** (Canvas, Projects, Admin, email, Sign Out): the same on every screen, with correct `aria-current` and a skip link. Good.
12. **Admin tab row beneath the header, not a sidebar**: the screenshots show it works well and keeps width for the tables. Ignore the bead's "side nav" wording, which is just a name.
13. **Editor doc bar.**
    - The Save/Export/Share order is conventional.
    - The doc bar's back button uses `btn--secondary`, which is correctly a button (it runs the unsaved check).
    - Editor `<h1>` is visually hidden (DiagramEditor.tsx:207) with the doc name shown in the bar. That is fine.
    - The status text "idle" next to Save is odd jargon. Consider "Saved" and "Unsaved changes".
14. **Breadcrumb on the project page** (see finding 4).
15. **Empty states.** Not captured as a screenshot, because no data was modified. The code (create-first-project, shared list hidden when empty) follows the design doc, so I left them alone, apart from finding 8.
16. **Heading levels on Browse screens.** `<h1 className="page__title">` is consistent between Projects and the project page, and the in-list headings ("Shared with me") are `<h2>`. Good. The problem is admin only (finding 1).

### Suggested order of work
1. canvas-513 fix (a), plus remove Admin Back and add an e2e test.
2. Admin `<h1>`s and `document.title`, then Overview cards. Do these together, since Overview changes anyway.
3. Phone layout.
4. Unify row styling, then the rest.
