import * as bip39 from "bip39";
import * as bip32 from "bip32";
import * as secp from "tiny-secp256k1";

export function generateMnemonic(strength: 128|256 = 128) {
  return bip39.generateMnemonic(strength);
}

export function validateMnemonic(mnemonic: string) {
  return bip39.validateMnemonic(mnemonic);
}

export async function mnemonicToSeed(mnemonic: string) {
  return bip39.mnemonicToSeed(mnemonic);
}

export async function deriveFromMnemonic(mnemonic: string, derivationPath: string) {
  const seed = await mnemonicToSeed(mnemonic);
  const root = bip32.BIP32Factory(secp).fromSeed(seed);
  const node = root.derivePath(derivationPath);
  return node; // contains privateKey, publicKey
}
