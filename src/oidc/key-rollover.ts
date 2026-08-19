export class SigningKeyRolloverState {
  #published = false;

  get published(): boolean {
    return this.#published;
  }

  publish(): void {
    this.#published = true;
  }

  reset(): void {
    this.#published = false;
  }
}
