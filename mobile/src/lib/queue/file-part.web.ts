import { LocalDataError } from "./core";

type FileRef = { field: string; uri: string; name: string; type: string };

/** Browsers need a Blob: image picker results are blob:/data: URLs. */
export async function filePart(form: FormData, file: FileRef): Promise<void> {
  let blob: Blob;
  try {
    blob = await (await fetch(file.uri)).blob();
  } catch {
    throw new LocalDataError(`The photo "${file.name}" is no longer available. Discard this and capture it again.`);
  }
  form.append(file.field, new File([blob], file.name, { type: file.type || blob.type }));
}
