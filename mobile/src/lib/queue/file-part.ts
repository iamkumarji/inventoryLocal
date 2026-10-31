import { File } from "expo-file-system";

import { LocalDataError } from "./core";

type FileRef = { field: string; uri: string; name: string; type: string };

/** React Native's FormData uploads a local file from its URI. */
export async function filePart(form: FormData, file: FileRef): Promise<void> {
  if (!new File(file.uri).exists) {
    throw new LocalDataError(`The photo "${file.name}" is no longer on this phone. Discard this and capture it again.`);
  }
  form.append(file.field, { uri: file.uri, name: file.name, type: file.type } as unknown as Blob);
}
