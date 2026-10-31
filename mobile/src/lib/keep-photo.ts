import { Directory, File, Paths } from "expo-file-system";

import { newId } from "./ids";

/**
 * The picker leaves photos in the OS cache, which may be cleared before a queued upload runs.
 * Queued photos are copied into the app's documents folder and removed once sent.
 */
export async function keepPhoto(uri: string, name: string): Promise<string> {
  const dir = new Directory(Paths.document, "queued-photos");
  dir.create({ idempotent: true, intermediates: true });
  const dest = new File(dir, `${newId()}-${name}`);
  await new File(uri).copy(dest);
  return dest.uri;
}

export function forgetPhoto(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // already gone
  }
}
