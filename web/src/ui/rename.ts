/** The pencil drawn on a list row's rename button. */
export const PENCIL = '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

/** A row's rename button: a pencil labelled for the item it renames. */
export function renameButton(name: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'track-rename';
  b.setAttribute('aria-label', `Rename ${name}`);
  b.innerHTML = PENCIL;
  b.onclick = onClick;
  return b;
}

/** The longest name kept (a pasted paragraph is cut there). */
export const NAME_MAX = 80;

/**
 * Turns a list row into a name field with Save and Cancel, the current name filled in and selected.
 * Save (or Enter) with a changed, non-empty name calls `save`; Cancel, Escape or an unchanged name
 * calls `cancel`. The caller redraws the row either way.
 */
export function editName(row: HTMLElement, current: string, save: (name: string) => void, cancel: () => void): void {
  const form = document.createElement('form');
  form.className = 'rename-form';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = current;
  input.maxLength = NAME_MAX;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Name');
  const ok = document.createElement('button');
  ok.type = 'submit';
  ok.className = 'primary';
  ok.textContent = 'Save';
  const no = document.createElement('button');
  no.type = 'button';
  no.textContent = 'Cancel';
  form.append(input, ok, no);
  const done = (name: string | null) => {
    const clean = name?.trim().replace(/\s+/g, ' ') ?? '';
    if (clean && clean !== current) save(clean);
    else cancel();
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    done(input.value);
  };
  no.onclick = () => done(null);
  input.onkeydown = (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation(); // the panel's Escape closes the panel; here it only stops renaming
    done(null);
  };
  row.classList.add('renaming');
  row.replaceChildren(form);
  input.focus();
  input.select();
}
