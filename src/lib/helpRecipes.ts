/**
 * In-app help recipes (P5-43). The intern's manual, kept next to the thing
 * it describes instead of in a document nobody opens.
 *
 * Rules for anything added here:
 *  - One recipe answers one "how do I…", in the order you would actually do it.
 *  - One plain sentence per step. No jargon, no "simply", no screenshots to
 *    go stale. Quote the button labels the app really shows, so the words on
 *    screen and the words here are the same words.
 *  - Only describe what EXISTS. A recipe for a half-built feature is worse
 *    than no recipe: it makes the person doubt themselves, not the app.
 *  - `href` points at the surface the recipe describes, so "Take me there"
 *    always lands somewhere real. Its path must be a route (see the spec).
 */
import { ref } from 'vue'

/** The six shelves of the manual, in the order the drawer lists them. */
export const RECIPE_TAGS = ['Find things', 'Ask', 'Look at data', 'Maps', 'Add things', 'Read'] as const

export type RecipeTag = (typeof RECIPE_TAGS)[number]

export interface HelpRecipe {
  id: string
  title: string
  steps: string[]
  href: string
  tag: RecipeTag
}

export const HELP_RECIPES: readonly HelpRecipe[] = [
  // ---------------------------------------------------------------- Find things
  {
    id: 'search-everything',
    title: 'Find anything, from anywhere',
    tag: 'Find things',
    href: '/search',
    steps: [
      'Press ⌘K (Ctrl-K on Windows) from any page, or click "Search" in the top bar.',
      'Type a few words — datasets, pages, analyses, documents, notes, layers and sources are all searched at once.',
      'The results are grouped by kind, each with a badge and a one-line verdict; press one to open it.',
      'Narrow them with the chips: kind, organization, topic, type, purpose.',
      'When the catalog returns little, an "Inside documents" group lists the pages of documents the phrase appears on.',
      'In the ⌘K box, ↑ and ↓ move through the results and Enter opens the highlighted one; Enter with nothing highlighted opens the full Search page.',
    ],
  },
  {
    id: 'browse-datasets',
    title: 'Browse the datasets',
    tag: 'Find things',
    href: '/datasets',
    steps: [
      'Click "Datasets" in the row of tabs under the title.',
      'Everything dataset-shaped is here: the tables we hold, the sources we only index, and the map\u2019s own layers.',
      'Use "Group the datasets by" to arrange them by Organization, Topic or Type; your choice is remembered.',
      'Narrow the list with the search box and the chips — Held, Indexed, Map layers, then publisher, topic and type.',
      'Every row says whether we hold it or only point at it, and what it is ready for.',
      'The web address carries the grouping and the filters, so the view you are looking at is a link you can send.',
    ],
  },
  {
    id: 'browse-docs',
    title: 'Browse the pages, documents and notes',
    tag: 'Find things',
    href: '/docs',
    steps: [
      'Click "Docs" in the row of tabs under the title.',
      'Use "Group the documents by" for Purpose (strategy, research, outreach, ideas), Topic or Kind.',
      'Ideas are a chip here rather than a page of their own — press "Ideas" under "Filter by purpose".',
      'Anything you dropped and have not filed yet appears at the top under "To file"; admins see everybody\u2019s.',
      'Click a title to open the page or the entry behind it.',
    ],
  },
  {
    id: 'layer-about',
    title: "Read up on a map layer before you use it",
    tag: 'Find things',
    href: '/datasets',
    steps: [
      'Open "Datasets" and press "Map layers" under "Filter by readiness".',
      'Search by the layer name, or by what it measures.',
      'Click the layer to see what the numbers are, which direction counts as good, the range they run between, and where they came from.',
      'Scroll to "County by county" to search, sort and download the layer county by county.',
      'Click "Show on map" when you want to see it drawn instead of described.',
    ],
  },

  // ----------------------------------------------------------------------- Ask
  {
    id: 'ask-question',
    title: 'Ask a question and check the answer',
    tag: 'Ask',
    href: '/chat',
    steps: [
      'Click "Chat" in the top bar and type your question in plain English.',
      'The answer is written as it arrives, with a collapsed line for every tool the assistant used along the way.',
      'Read the answer, then read the "Where this came from" list under it — the [1], [2] markers point at the material each part came from.',
      'Open a source and check it yourself before you use the answer anywhere: it is a starting point, not a citation.',
      'Keep what you got with "Save as note" or "Add to page…", and press "Open" when the answer is an analysis you can look at.',
      'Ask a follow-up in the same thread — it remembers the turn before. "New chat" starts a fresh one.',
    ],
  },
  {
    id: 'chat-writes',
    title: 'Let Chat file something for you',
    tag: 'Ask',
    href: '/chat',
    steps: [
      'Ask for the thing you want done — "drop this link", "save that as a note", "add this to the Georgia page".',
      'The assistant never writes anything by itself: it proposes the change and shows you exactly what it would do.',
      'Read the proposal, then press "Run" to let it happen or "Cancel" to leave it alone.',
      'Anything that runs is recorded as having been done "via chat", so the activity feed says where it came from.',
    ],
  },
  {
    id: 'check-a-place',
    title: 'Check a property or county for risks',
    tag: 'Ask',
    href: '/analysis',
    steps: [
      'Click "Analysis" in the row of tabs, then "Start" on the "Check a place" card — or "Place report" on a county in the map.',
      'Type a street address, or search for a county, and set how far around the point to look.',
      'Press "Run" and wait — it says "Checking 14 sources…" while it asks every data source that covers the place.',
      'Read the summary first, then the sources under it: each one says how many results it found, nothing within the radius, or that it has to be checked by hand.',
      'Click "Open the full slice" on any source that found something to see every row, and "About this source" for who publishes it.',
      'Keep it with "Save as note" or "Add to page…", or take the list of sources away with "Download CSV".',
      'Press "Run again" when you want today\'s numbers rather than the copy from earlier this week.',
    ],
  },
  {
    id: 'ask-dataset',
    title: 'Ask about one dataset',
    tag: 'Ask',
    href: '/datasets',
    steps: [
      'Open the dataset from "Datasets" and click its "Data" tab.',
      'Use the "Ask about this data…" box that sits above the table.',
      'The answer page confirms the question was kept to that table, and links back to it.',
      'Check the "What I counted" card: it shows the row count and the filter in plain English, with "Open in table" to see the rows for yourself.',
    ],
  },

  // --------------------------------------------------------------- Look at data
  {
    id: 'open-table',
    title: "Open a dataset's table",
    tag: 'Look at data',
    href: '/datasets',
    steps: [
      'Open the dataset from "Datasets" — press "Held" under "Filter by readiness" to see only the tables we actually have.',
      'Click the "Data" tab — it only appears on entries that have a table in them.',
      'The line above the table says how many rows there are, how many match your filters, and how many columns.',
      'Click any row to open a panel showing every column for that one record; Esc closes it.',
      'Use "← Prev" and "Next →" at the bottom to page through, or change "Rows per page".',
    ],
  },
  {
    id: 'filter-sort',
    title: 'Filter and sort a table',
    tag: 'Look at data',
    href: '/datasets',
    steps: [
      'Click a column name to sort by it: once for A→Z (or smallest first), again to reverse it, a third time to turn sorting off.',
      'Click the small ⌄ next to a column name to filter on that column.',
      'Choose how to match — contains, is, ≥, ≤, is empty, is not empty — type a value, then press "Apply".',
      'Each filter appears as a chip above the table; click its × to take it off.',
      'The "Search all columns…" box searches every column at once, and "Clear all" resets the search, the filters and the sorting.',
      'The web address carries your filters, so you can copy it to a colleague or paste it into a page.',
    ],
  },
  {
    id: 'summaries',
    title: 'See what is in a column, and count rows by it',
    tag: 'Look at data',
    href: '/datasets',
    steps: [
      'On the "Data" tab, click "Summaries" to open the panel beside the table.',
      'Every column is listed with how much of it is filled in; click one to look closer.',
      'Number columns show the smallest, middle, largest and average value, and how the values spread out; text columns show the most common values.',
      'Click "Group by this column" for a "Rows counted by …" table of counts and shares.',
      'Click any value or bar to filter the table down to it, or press "Download this table as CSV" to keep the counts.',
      'Summaries always describe the rows matching your current filters, not the whole file.',
    ],
  },
  {
    id: 'download-csv',
    title: 'Download exactly the rows you are looking at',
    tag: 'Look at data',
    href: '/datasets',
    steps: [
      'Search, filter and sort the table until it shows what you want.',
      'Use "Columns" to hide the columns you do not need.',
      'Click "Download filtered CSV": you get the rows that matched, in the order on screen, with only the columns still showing.',
      'For counts rather than rows, use "Download this table as CSV" inside a group-by summary instead.',
    ],
  },
  {
    id: 'county-context',
    title: 'Add county numbers next to your rows',
    tag: 'Look at data',
    href: '/datasets',
    steps: [
      'Open a dataset that has counties in it (a GEOID or FIPS column, or rows that were geocoded) and go to its "Data" tab.',
      'Press "Add county context" and tick up to six map layers, such as Percent Black or Median home value.',
      'Each layer appears as a new column with that county\'s number; sort by it, open a row to see it, and share the page link — the layers travel with it.',
      'Use "Download this page with county context" to take the joined rows with you.',
    ],
  },

  // ---------------------------------------------------------------------- Maps
  {
    id: 'compare-counties',
    title: 'Put a few counties side by side',
    tag: 'Maps',
    href: '/analysis',
    steps: [
      'Add counties to the shortlist as you go — from the map, or from a layer\'s county table.',
      'The "Analysis" tab carries a badge with how many are waiting.',
      'Open "Analysis" and press "Start" on the "Compare" card.',
      'Pick the layers that matter and read the counties across them, then keep the comparison with "Save view".',
    ],
  },
  {
    id: 'layers-from-link',
    title: 'Turn a layer on from a link',
    tag: 'Maps',
    href: '/',
    steps: [
      'Any "Show on map" link — in search results, on an entry, on a layer page — opens the map with that layer already drawn.',
      'The web address carries the layers with it, so copying it shares exactly what you are looking at.',
      'Add more layers by clicking "Show on map" somewhere else, or from the map\'s own Layers panel.',
      'Internal layers only draw once you are logged in; a colleague who is logged out just sees the public map.',
    ],
  },
  {
    id: 'save-view',
    title: 'Save a map view so you can come back to it',
    tag: 'Maps',
    href: '/',
    steps: [
      'Set the map up the way you want it: layers on, filters set, the area you care about on screen.',
      'Click "Save view" at the bottom left of the map — it only shows when you are logged in.',
      'Type a name and press "Save".',
      'The confirmation gives you the short code for putting the view inside a page.',
      'Find the view again under "Recent analyses" on the "Analysis" tab, and share its link with anyone on the team.',
    ],
  },
  {
    id: 'open-record',
    title: 'Open a record you clicked on the map',
    tag: 'Maps',
    href: '/',
    steps: [
      'Turn on a layer of points; each record is a dot, and dots gather into numbered circles until you zoom in.',
      'Click a dot: a popup shows that record, and the list beside the map scrolls to the same one.',
      'Click "Open record →" in the popup to land on the dataset table with that record already searched for.',
      'Or search the list beside the map by name, and click a row to fly to it.',
    ],
  },

  // --------------------------------------------------------------- Add things
  {
    id: 'drop-link',
    title: 'Drop a link you cannot download yet',
    tag: 'Add things',
    href: '/new',
    steps: [
      'Click "New" in the top bar and use the "A link" panel.',
      'Paste the address. The title and the note are optional.',
      'Use the note for what a colleague would need to know: what it is, what format we would want, whether it needs a login.',
      'Press "Drop link". It goes into the to-file queue, so nothing is lost while it waits for a title and a category.',
    ],
  },
  {
    id: 'inspect-link',
    title: 'Found a dataset? Drop the link and see what it is',
    tag: 'Add things',
    href: '/new',
    steps: [
      'Drop the link as usual. The server looks at it straight away and says what it found.',
      'Open the entry. The line under "What this is" says whether it is an ArcGIS layer, a Socrata dataset, a file we could copy, a portal page listing downloads, or just a web page.',
      'If it is a catalogue page, press "Drop this link" next to the download you actually want — that becomes its own entry.',
      'If it is a real dataset, press "Register as a data source". The form fills in from the service; anything marked "inferred" was worked out by the machine, so read it before pressing File.',
      'Ask Nick to set the ingest plan. That is the decision about whether we point at it, query it per place, copy it in, or just read it.',
    ],
  },
  {
    id: 'upload-files',
    title: 'Upload a document, or a whole folder of them',
    tag: 'Add things',
    href: '/new',
    steps: [
      'Click "New" in the top bar. "A document" is for one file with its own description; "Many documents" takes a folder, or a pile of files at once.',
      'For one file, fill in the title, category, tags and notes, then press "File" — or press "Quick drop" to upload now and describe it later.',
      'For many, the page reads each file and proposes a title, a summary, a publisher, a topic and tags, and shows the cost before it starts.',
      'Nothing the machine proposes is applied on its own: each row shows it greyed, with "Accept", "Edit" and "Accept all".',
      'If the model is unavailable the files still land, with what could be read from them and a line saying so; "Look again" re-runs it later.',
    ],
  },
  {
    id: 'to-file',
    title: 'What "To file" means, and how to clear it',
    tag: 'Add things',
    href: '/docs',
    steps: [
      'Anything added with "Quick drop", and any dropped link without a title, is filed as needing cataloging.',
      'It appears under "To file" at the top of "Docs" — yours, and everybody\'s if you are an admin.',
      'Open one and fill in the "File this entry" form: a title, a category, tags, and a note about what it is.',
      'Press "File". Filing never touches the file itself — it only adds the description around it.',
    ],
  },
  {
    id: 'write-page',
    title: 'Write a page',
    tag: 'Add things',
    href: '/docs',
    steps: [
      'Open "Docs", type a title into "New page title…", and press "New page".',
      'Write on the left; the preview beside it shows how the page will read (on a narrow screen, swap between "Write" and "Preview").',
      'Use the toolbar for headings, bold, lists, links and tables — ⌘B, ⌘I and ⌘K do the same job.',
      'Press "Create page" to save it. After that the button says "Save".',
      'If you wander off mid-sentence your text is kept as a draft, and the editor offers it back when you return.',
    ],
  },
  {
    id: 'embed-in-page',
    title: 'Put a dataset or a saved map view inside a page',
    tag: 'Add things',
    href: '/docs',
    steps: [
      'Edit the page and put the cursor on a blank line where the card should sit.',
      'Click "Embed", search the library, and click the entry or saved view you want.',
      'It writes a short code into the page; that code becomes a card when the page is saved.',
      'The card links straight to the entry, its table, or the map, so readers do not have to go hunting.',
      'Use "Insert citation" the same way to quote an answer you got from Chat.',
    ],
  },

  // ---------------------------------------------------------------------- Read
  {
    id: 'open-document',
    title: 'Open a PDF or a document without downloading it',
    tag: 'Read',
    href: '/docs',
    steps: [
      'Open the entry from "Docs" and click its "Files" tab.',
      'Click the file name. PDFs, images, Markdown, plain text, CSV and JSON all open right there in the page.',
      'Click "← Files" to go back to the list, or "Download" to keep your own copy.',
      'Files over 25 MB, and file types the viewer cannot show, offer a download instead and say so.',
    ],
  },
  {
    id: 'find-in-document',
    title: 'Find a phrase inside a document',
    tag: 'Read',
    href: '/docs',
    steps: [
      'Open the document in the app first: the entry\'s "Files" tab, then the file name.',
      'For a PDF, press "Text" above the page to switch to the extracted text, then type in the "Find in document" box; Enter jumps to the next match and the counter shows where you are.',
      'Word and RTF files open as text straight away, with the same find box.',
      'To find WHICH document mentions something, rather than where in one, use Search: when the catalog turns up little it lists "Inside documents" with the page numbers, and each opens the PDF there.',
    ],
  },
]

/** Case-insensitive match on title, steps and shelf — the drawer's filter. */
export function searchRecipes(query: string, recipes: readonly HelpRecipe[] = HELP_RECIPES): HelpRecipe[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...recipes]
  return recipes.filter(r =>
    [r.title, r.tag, ...r.steps].some(text => text.toLowerCase().includes(needle)),
  )
}

/** Recipes on their shelves, empty shelves dropped. */
export function groupRecipes(recipes: readonly HelpRecipe[]): Array<{ tag: RecipeTag; recipes: HelpRecipe[] }> {
  return RECIPE_TAGS.map(tag => ({ tag, recipes: recipes.filter(r => r.tag === tag) })).filter(g => g.recipes.length > 0)
}

/**
 * Whether the drawer is open. The drawer itself lives in the header (next to
 * the ⌘K box) but the knowledge-base landing also opens it, so the flag is
 * shared module state rather than a prop threaded through two unrelated trees.
 */
export const helpDrawerOpen = ref(false)

export function openHelpDrawer(): void {
  helpDrawerOpen.value = true
}

export function closeHelpDrawer(): void {
  helpDrawerOpen.value = false
}
