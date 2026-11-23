import { emptyDoc } from '../cad/doc';
import { openStore } from '../io/store';
import { CadEditor } from './cad/editor';
import { mountJobBar } from './jobBar';
import { mountOpsPanel } from './opsPanel';
import { mountToolPanel } from './toolPanel';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
<header>
  <h1>Onefinity CAM</h1>
  <nav><button data-tab="draw" class="on">Drawing</button><button data-tab="paths">Toolpaths</button><button data-tab="tools">Tool library</button></nav>
  <div id="jobbar" class="jobbar"></div>
</header>
<main>
  <div id="draw" class="tab on"></div>
  <div id="paths" class="tab"></div>
  <div id="tools" class="tab"><div class="pad"><h2>Tool library</h2><div id="toolpanel"></div></div></div>
</main>`;

const { store } = await openStore();
const editor = new CadEditor(document.querySelector<HTMLDivElement>('#draw')!, emptyDoc());
const job = await mountJobBar(document.querySelector<HTMLDivElement>('#jobbar')!, store, editor);
await mountToolPanel(document.querySelector<HTMLDivElement>('#toolpanel')!, store);

const showTab = (t: string) => {
  app.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.tab === t));
  app.querySelectorAll('.tab').forEach((p) => p.classList.toggle('on', p.id === t));
  if (t === 'paths') ops.shown();
};
const ops = mountOpsPanel(document.querySelector<HTMLDivElement>('#paths')!, job, editor, store, () => showTab('draw'));

app.querySelector('nav')!.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]')?.dataset.tab;
  if (t) showTab(t);
});
