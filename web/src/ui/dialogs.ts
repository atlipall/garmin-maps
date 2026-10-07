/**
 * The panels and cards over the map, each with how to put it away, so that opening the menu can
 * clear the screen for it. A dialog's own way of closing decides what "away" means: the route card,
 * for one, folds up rather than dropping a route.
 */
export class Dialogs {
  private readonly closers = new Map<string, () => void>();

  /** Registers (or replaces) how the dialog `name` closes. */
  add(name: string, close: () => void): void {
    this.closers.set(name, close);
  }

  /** Closes every dialog; one that fails doesn't keep the rest open. */
  closeAll(): void {
    for (const [name, close] of this.closers) {
      try {
        close();
      } catch (err) {
        console.warn(`closing ${name}`, err);
      }
    }
  }
}
