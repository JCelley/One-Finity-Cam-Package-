import { parse, type Font } from 'opentype.js';
import type { Store } from '../io/store';
import alfa from '@fontsource/alfa-slab-one/files/alfa-slab-one-latin-400-normal.woff?url';
import bebas from '@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff?url';
import cinzel from '@fontsource/cinzel/files/cinzel-latin-700-normal.woff?url';
import dancing from '@fontsource/dancing-script/files/dancing-script-latin-700-normal.woff?url';
import greatVibes from '@fontsource/great-vibes/files/great-vibes-latin-400-normal.woff?url';
import lobster from '@fontsource/lobster/files/lobster-latin-400-normal.woff?url';
import montserrat from '@fontsource/montserrat/files/montserrat-latin-700-normal.woff?url';
import oswald from '@fontsource/oswald/files/oswald-latin-600-normal.woff?url';
import pacifico from '@fontsource/pacifico/files/pacifico-latin-400-normal.woff?url';
import playfair from '@fontsource/playfair-display/files/playfair-display-latin-700-normal.woff?url';
import robotoSlab from '@fontsource/roboto-slab/files/roboto-slab-latin-700-normal.woff?url';
import rye from '@fontsource/rye/files/rye-latin-400-normal.woff?url';

/**
 * Fonts for the text tool: a bundled set (all SIL Open Font License, see LICENSES.md) plus any
 * font file the user loads, kept in the browser store. Parsed fonts are cached.
 * Ids: bundled fonts by their key, user fonts as `user:<name>`.
 */
const BUNDLED: { id: string; name: string; url: string }[] = [
  { id: 'montserrat', name: 'Montserrat Bold (sans)', url: montserrat },
  { id: 'oswald', name: 'Oswald (condensed)', url: oswald },
  { id: 'bebas', name: 'Bebas Neue (tall capitals)', url: bebas },
  { id: 'roboto-slab', name: 'Roboto Slab Bold', url: robotoSlab },
  { id: 'alfa', name: 'Alfa Slab One (heavy slab)', url: alfa },
  { id: 'playfair', name: 'Playfair Display Bold (serif)', url: playfair },
  { id: 'cinzel', name: 'Cinzel Bold (Roman capitals)', url: cinzel },
  { id: 'rye', name: 'Rye (western)', url: rye },
  { id: 'lobster', name: 'Lobster (bold script)', url: lobster },
  { id: 'pacifico', name: 'Pacifico (brush script)', url: pacifico },
  { id: 'dancing', name: 'Dancing Script Bold', url: dancing },
  { id: 'great-vibes', name: 'Great Vibes (fine script)', url: greatVibes },
];

export const DEFAULT_FONT = 'montserrat';

export class FontCatalog {
  private cache = new Map<string, Promise<Font>>();
  constructor(private store: Store) {}

  async list(): Promise<{ id: string; name: string }[]> {
    const user = await this.store.listFonts();
    return [...BUNDLED.map(({ id, name }) => ({ id, name })), ...user.map((n) => ({ id: `user:${n}`, name: `${n} (yours)` }))];
  }

  get(id: string): Promise<Font> {
    let p = this.cache.get(id);
    if (!p) {
      p = (async () => {
        let data: ArrayBuffer | null;
        if (id.startsWith('user:')) data = await this.store.getFont(id.slice(5));
        else {
          const b = BUNDLED.find((f) => f.id === id);
          data = b ? await (await fetch(b.url)).arrayBuffer() : null;
        }
        if (!data) throw new Error(`the font "${id.replace(/^user:/, '')}" isn't available in this browser; load it again with Load font…`);
        return parse(data);
      })();
      p.catch(() => this.cache.delete(id));
      this.cache.set(id, p);
    }
    return p;
  }

  /** checks a font file parses, stores it, returns its id */
  async add(fileName: string, data: ArrayBuffer): Promise<string> {
    let font: Font;
    try {
      font = parse(data);
    } catch (err) {
      throw new Error(`that file isn't a font this app can read (TTF, OTF or WOFF; not WOFF2): ${(err as Error).message}`);
    }
    if (!font.unitsPerEm) throw new Error("that font has no outlines this app can read");
    const name = fileName.replace(/\.(ttf|otf|woff)$/i, '');
    await this.store.putFont(name, data);
    const id = `user:${name}`;
    this.cache.set(id, Promise.resolve(font));
    return id;
  }
}
