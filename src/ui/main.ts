import { DEFAULT_TOOLS, describeTool } from '../cam/tools/library';
import { MACHINES } from '../cam/machines';

// Placeholder shell until the CAD canvas (milestone 2) lands: shows the machine and tool library.
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
<style>
  :root { color-scheme: light dark; font: 14px/1.5 system-ui, sans-serif; }
  body { margin: 0; padding: 16px; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  section { margin-bottom: 16px; }
</style>
<h1>Onefinity CAM</h1>
<section><b>Machines</b><ul>${MACHINES.map((m) => `<li>${m.name}: ${m.travel.x} × ${m.travel.y} × ${m.travel.z} mm</li>`).join('')}</ul></section>
<section><b>Tool library (MASSO tool numbers)</b><ul>${DEFAULT_TOOLS.map((t) => `<li>${describeTool(t)} — ${t.name}</li>`).join('')}</ul></section>
<p>CAD canvas and operations are coming next.</p>`;
