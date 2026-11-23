import { MACHINES } from '../cam/machines';
import { openStore } from '../io/store';
import { mountToolPanel } from './toolPanel';
import './style.css';

// Placeholder shell until the CAD canvas (milestone 2) lands: machines and the tool library.
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
<h1>Onefinity CAM</h1>
<section><h2>Tool library</h2><div id="tools"></div></section>
<section><h2>Machines</h2><ul>${MACHINES.map((m) => `<li>${m.name}: ${m.travel.x} × ${m.travel.y} × ${m.travel.z} mm</li>`).join('')}</ul></section>
<p class="hint">Job files (drawing + operations) open and save the same way once the CAD canvas is in.</p>`;

const { store } = await openStore();
await mountToolPanel(document.querySelector<HTMLDivElement>('#tools')!, store);
