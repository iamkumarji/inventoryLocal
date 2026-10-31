/**
 * Browser build: picked images come back as blob: URLs, which die with the page. Keep them as data: URIs
 * so a queued upload survives reloads (the native app copies the file into app storage instead).
 */
export async function keepPhoto(uri: string): Promise<string> {
  if (uri.startsWith("data:")) return uri;
  const blob = await (await fetch(uri)).blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the photo."));
    reader.readAsDataURL(blob);
  });
}

export function forgetPhoto(): void {}
