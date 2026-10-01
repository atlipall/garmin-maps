const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Shows the "new version" notice: Reload loads it (the app restores where you were, see
 *  session.ts), × hides it until the next start. While navigating it waits (CSS hides it), so it
 *  doesn't cover the guidance. */
export function showUpdateNotice(): void {
  const el = $('update');
  $('update-reload').onclick = () => location.reload();
  $('update-close').onclick = () => {
    el.hidden = true;
  };
  el.hidden = false;
}
