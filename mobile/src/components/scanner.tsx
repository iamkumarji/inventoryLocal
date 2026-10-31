import { CameraView, useCameraPermissions } from "expo-camera";
import { useRef, useState } from "react";
import { Modal, Platform, StyleSheet, View } from "react-native";

import { Body, Button, Input } from "./ui";

/**
 * Barcode/QR entry: camera scanning where available, always with a typed fallback (gloves, damaged
 * labels, devices without a camera). Calls onCode once per scan.
 */
export function CodeEntry({ label, onCode, testID }: { label: string; onCode: (code: string) => void; testID?: string }) {
  const [typed, setTyped] = useState("");
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const handled = useRef(false);

  const startScan = async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) return;
    }
    handled.current = false;
    setScanning(true);
  };

  return (
    <View style={{ gap: 10 }}>
      <Input
        testID={testID}
        label={label}
        value={typed}
        onChangeText={setTyped}
        autoCapitalize="characters"
        autoCorrect={false}
        returnKeyType="search"
        onSubmitEditing={() => typed.trim() && onCode(typed.trim())}
      />
      <View style={{ flexDirection: "row", gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Button title="Find" onPress={() => typed.trim() && onCode(typed.trim())} disabled={!typed.trim()} testID={testID ? `${testID}-find` : undefined} />
        </View>
        {Platform.OS !== "web" ? (
          <View style={{ flex: 1 }}>
            <Button title="Scan" kind="secondary" onPress={startScan} />
          </View>
        ) : null}
      </View>
      {permission && !permission.granted && !permission.canAskAgain ? (
        <Body muted>Camera access is off for this app. Type the code, or allow the camera in the phone’s settings.</Body>
      ) : null}
      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <View style={styles.camera}>
          <CameraView
            style={StyleSheet.absoluteFill}
            barcodeScannerSettings={{ barcodeTypes: ["qr", "ean13", "ean8", "code128", "code39", "datamatrix", "upc_a", "itf14"] }}
            onBarcodeScanned={({ data }) => {
              if (handled.current) return;
              handled.current = true;
              setScanning(false);
              setTyped(data);
              onCode(data);
            }}
          />
          <View style={styles.close}>
            <Button title="Cancel" kind="secondary" onPress={() => setScanning(false)} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  camera: { flex: 1, backgroundColor: "#000" },
  close: { position: "absolute", left: 16, right: 16, bottom: 40 },
});
