import * as ImagePicker from "expo-image-picker";
import { Image, Platform, View } from "react-native";

import { keepPhoto } from "@/lib/keep-photo";
import type { Photo } from "@/lib/operations";

import { Body, Button } from "./ui";

/** Takes (or on the browser build, picks) one photo; compressed before upload. */
export function PhotoField({ label, value, onChange, testID }: { label: string; value: Photo | null; onChange: (p: Photo | null) => void; testID?: string }) {
  const take = async () => {
    // The browser build asks for base64 so the photo can be kept as a data: URI across reloads.
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.6, exif: false, base64: Platform.OS === "web" };
    let result: ImagePicker.ImagePickerResult;
    if (Platform.OS === "web") {
      result = await ImagePicker.launchImageLibraryAsync(options);
    } else {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) return;
      result = await ImagePicker.launchCameraAsync(options);
    }
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    const type = asset.mimeType ?? "image/jpeg";
    const name = asset.fileName ?? `photo-${Date.now()}.${type.split("/")[1] ?? "jpg"}`;
    const source = Platform.OS === "web" && asset.base64 ? `data:${type};base64,${asset.base64}` : asset.uri;
    onChange({ uri: await keepPhoto(source, name), name, type });
  };
  return (
    <View style={{ gap: 8 }}>
      <Body muted>{label}</Body>
      {value ? <Image source={{ uri: value.uri }} accessibilityLabel={label} style={{ width: "100%", height: 180, borderRadius: 6 }} resizeMode="cover" /> : null}
      <View style={{ flexDirection: "row", gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Button testID={testID} title={value ? "Retake photo" : "Take photo"} kind="secondary" onPress={take} />
        </View>
        {value ? (
          <View style={{ flex: 1 }}>
            <Button title="Remove" kind="secondary" onPress={() => onChange(null)} />
          </View>
        ) : null}
      </View>
    </View>
  );
}
