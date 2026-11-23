# Licenses

Everything this app ships is licensed for commercial use. Re-check whenever a dependency is added.

## Bundled fonts (text tool)

All from Google Fonts via the `@fontsource` npm packages, under the **SIL Open Font License 1.1**
(fonts may be bundled and used, including commercially; they may not be sold on their own).
Only the font files the text tool lists are shipped.

| Font | Package | License |
|---|---|---|
| Montserrat Bold | `@fontsource/montserrat` | OFL-1.1 |
| Oswald SemiBold | `@fontsource/oswald` | OFL-1.1 |
| Bebas Neue | `@fontsource/bebas-neue` | OFL-1.1 |
| Roboto Slab Bold | `@fontsource/roboto-slab` | OFL-1.1 |
| Alfa Slab One | `@fontsource/alfa-slab-one` | OFL-1.1 |
| Playfair Display Bold | `@fontsource/playfair-display` | OFL-1.1 |
| Cinzel Bold | `@fontsource/cinzel` | OFL-1.1 |
| Rye | `@fontsource/rye` | OFL-1.1 |
| Lobster | `@fontsource/lobster` | OFL-1.1 |
| Pacifico | `@fontsource/pacifico` | OFL-1.1 |
| Dancing Script Bold | `@fontsource/dancing-script` | OFL-1.1 |
| Great Vibes | `@fontsource/great-vibes` | OFL-1.1 |

## Single-line engraving fonts

SVG fonts in `src/assets/strokefonts/`, copied unchanged (licence notes included in each file's
`<metadata>`) from the Evil Mad Scientist Hershey Text distribution, as packaged in the
`hersheytext` npm package 2.0.0. The package itself is not a dependency (it pulls in an old
`cheerio` with security advisories).

| Font | Source | License |
|---|---|---|
| EMS Readability, EMS Tech, EMS Nixish, EMS Osmotron, EMS Felix, EMS Allure | Sheldon B. Michaels, SVG conversion by Windell H. Oskay (single-line derivatives of OFL fonts) | OFL-1.1 |
| Hershey Sans 1-stroke, Hershey Serif medium, Hershey Script 1-stroke, Hershey Gothic English | Hershey fonts, SVG conversion by Windell H. Oskay | Hershey font licence (below) |

The Hershey licence allows any use, commercial included, provided these acknowledgements go with
the font data (they are also inside each file):
- The Hershey Fonts were originally created by Dr. A. V. Hershey while working at the U. S.
  National Bureau of Standards.
- The format of the Font data in this distribution was originally created by James Hurt,
  Cognition, Inc., 900 Technology Park Drive, Billerica, MA 01821.

and the data is not converted into the U.S. NTIS eight-byte-per-point format.

Fonts the user loads with "Load font…" stay in their browser and are never uploaded; the user is
responsible for their licence.

## Libraries

| Package | Used for | License |
|---|---|---|
| `three` | 3D preview | MIT |
| `clipper2-ts` (pinned 2.0.1) | offsets and booleans | BSL-1.0 |
| `opentype.js` (pinned 1.3.4) | reading font outlines | MIT |
