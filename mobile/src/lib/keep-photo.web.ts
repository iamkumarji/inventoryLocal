/** Browser build: the picker already returned a data: URI (see PhotoField), which survives reloads. */
export async function keepPhoto(uri: string): Promise<string> {
  return uri;
}

export function forgetPhoto(): void {}
