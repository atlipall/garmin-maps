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

/** The parts of a text field `suggestName` uses (a real input, or a stand-in in tests). */
export type NameField = Pick<HTMLInputElement, 'value' | 'setSelectionRange' | 'addEventListener'>;

const suggested = new WeakMap<NameField, string>();

/**
 * Fills a name field with a suggested name. While the name is unchanged, focusing or tapping the
 * field selects all of it, so one press of delete (or just typing) replaces it; a tap would
 * otherwise only put the caret where it landed. Once edited, the field behaves as usual.
 */
export function suggestName(input: NameField, name: string): void {
  input.value = name;
  if (!suggested.has(input)) {
    const unchanged = () => input.value === suggested.get(input);
    const selectIfSuggested = () => {
      if (unchanged()) input.setSelectionRange(0, input.value.length);
    };
    // After the tap has put its caret (click), and after focus settles (iOS moves the selection
    // once focus handlers have run). The tap's own caret placement, which the browser may finish
    // after the click, is cancelled at mouseup.
    input.addEventListener('mouseup', (e) => unchanged() && e.preventDefault());
    input.addEventListener('click', selectIfSuggested);
    input.addEventListener('focus', () => setTimeout(selectIfSuggested, 0));
  }
  suggested.set(input, name);
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
  suggestName(input, current);
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
