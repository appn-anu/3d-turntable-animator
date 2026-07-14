/**
 * App shell entry point. The real one-page UI (upload -> preview -> render) is
 * built in later milestones; for now this just confirms the module graph loads.
 */
const app = document.getElementById('app');
if (app) {
  const p = document.createElement('p');
  p.textContent = 'Preview and render UI coming in Milestone 1+.';
  app.appendChild(p);
}
