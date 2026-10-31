/** A memorable temporary password (at least 18 characters), generated with the browser's CSPRNG. */
export function temporaryPassword(): string {
  const words = ["lathe", "anvil", "rivet", "gauge", "spindle", "boiler", "forge", "valve", "pallet", "gasket", "turbine", "crane"];
  const bytes = crypto.getRandomValues(new Uint32Array(4));
  return `${words[bytes[0] % words.length]}-${words[bytes[1] % words.length]}-${words[bytes[2] % words.length]}-${(bytes[3] % 900) + 100}`;
}
