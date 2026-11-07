# EPUB Viewer, EPUB Reader & Ebook Reader

Read EPUB books in a VS Code tab, with pages or scrolling, a table of contents, search, footnote popups and a sepia or dark theme.

![EPUB Reader showing a sample book in the sepia theme, with the table of contents open and a chart inside the chapter](images/paged-sepia.png)

*Screenshot of VS Code 1.142 with a sample book made by `scripts/make-samples.js`.*

- Read the way you like. Turn pages like a book (two columns in a wide editor) or scroll each chapter, in your VS Code colors, light, sepia or dark.
- Find things fast. Search the whole book, click a note number to read the footnote in a popup, and jump anywhere from the contents.
- Pick up where you stopped. Each book opens at your last page, and book scripts never run.

## Quick start

1. Install the extension.
2. Click any `.epub` file in the Explorer.

## What you can do

| Action | How |
|---|---|
| Turn pages | Right and Left arrows, Page Down and Page Up, Space, the mouse wheel, or a click on the right or left edge of the page. |
| Jump to a chapter | The Contents button at the left end of the toolbar opens the list. EPUB 3 nav and EPUB 2 NCX lists are both read, with nested parts and sections. |
| Search the book | Type in "Search in book" and press Enter. Every match is listed with its chapter and highlighted in the text. Enter goes to the next match and Shift+Enter to the one before. |
| Read a footnote | Click the note number. The note opens in a popup, even when it lives in a separate notes file. Escape closes it. |
| Change the look | Theme (VS Code, Light, Sepia, Dark), A− and A+ for the text size, and Paged or Scrolled. Your choice is kept for every book. |
| See book details | Info shows the cover, title, author, language, ISBN, publisher, dates and EPUB version. |
| Save a chapter as Markdown | Markdown in the toolbar asks where to save the `.md` file and writes the chapter's images into a folder next to it. |

![Search results for a phrase, with the match highlighted on the page](images/search-results.png)

![A footnote opened in a popup next to its note number](images/footnote-popup.png)

![Book details with the cover, author, language and ISBN](images/book-info.png)

![Scrolled reading in the dark theme, with a search match still highlighted](images/scrolled-dark.png)

## Safe to open any book

- The book's HTML goes through an allow-list before it is shown. Scripts, event handlers, forms, frames, inline styles and remote images or style sheets are removed.
- The viewer page has a strict Content Security Policy as a second wall. Only its own script runs, and nothing can load from the internet.
- Links to websites open in your browser only when you click them.
- Books protected with DRM can't be read, and they get a clear message instead of garbled text.

## Big books

Only the parts of the book you open are read from disk. A 400-chapter test book opened in about a second, and a search of the whole book took under half a second. Books over 200 MB show a message and are not read (setting `epubReader.maxFileMB`).

## Settings

| Setting | Default | What it does |
|---|---|---|
| `epubReader.flow` | `paged` | `paged` or `scrolled` reading. |
| `epubReader.theme` | `auto` | `auto` uses your VS Code colors. Also `light`, `sepia` and `dark`. |
| `epubReader.fontSize` | `18` | Text size in pixels, 10 to 40. |
| `epubReader.fontFamily` | `serif` | `serif` or `sans`. |
| `epubReader.footnotePopups` | `true` | Footnotes open in a popup and EPUB 3 footnote boxes are hidden from the page. |
| `epubReader.rememberPosition` | `true` | Each book opens where you stopped. Positions stay on this computer. |
| `epubReader.maxFileMB` | `200` | Largest book to open. |
| `epubReader.askForRating` | `true` | Ask one time for a Marketplace rating after a few days of use. |
| `epubReader.showSupportLinks` | `true` | Show the small Sponsor and More free viewers links in the status line. |

## Privacy

No telemetry and no network calls. Books are read on your computer, reading positions are kept in VS Code's local storage, and the only file the extension writes is a Markdown export you asked for.

## Limits

- The book's own style sheet is not applied, so the reading themes and text size work in every book. Fonts embedded in the book are not used.
- Fixed-layout books (comics, picture books) are shown as flowing pages, so their page design is lost.
- Audio, video and inline SVG drawings are not shown. An SVG cover or picture shown as an image works.
- Search finds text inside one chapter at a time, so a phrase split across two chapters is not found.
- DRM-protected books can't be opened.

## Support Zovo

Zovo extensions are free, with no ads and no tracking. They are made by [theluckystrike](https://github.com/theluckystrike) on GitHub. If this one saves you time, you can support the work:

- [Sponsor on GitHub](https://github.com/sponsors/theluckystrike)
- [Follow theluckystrike on GitHub](https://github.com/theluckystrike)

## More tools by Zovo

- [PDF Viewer & PDF Reader with Dark Mode](https://marketplace.visualstudio.com/items?itemName=zovo.pdf-viewer-dark) reads PDFs with a real dark mode, search, an outline and thumbnails.
- [DOCX Viewer & Word Viewer with Dark Mode](https://marketplace.visualstudio.com/items?itemName=zovo.docx-viewer-vscode) previews Word and ODT files with dark mode, an outline and search.
- [PPTX Viewer & PowerPoint Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.pptx-slide-viewer) shows PowerPoint slides, thumbnails and speaker notes.
- [Graphviz Preview & DOT Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.zovo-graphviz-preview) shows a live preview of DOT files and exports SVG or PNG.

See [all Zovo extensions on the Marketplace](https://marketplace.visualstudio.com/publishers/zovo).

## License

MIT. fflate (MIT) is bundled, see `THIRD-PARTY-NOTICES.md`.
